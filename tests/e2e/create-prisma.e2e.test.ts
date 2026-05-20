import { afterEach, describe, expect, test } from "bun:test";
import { startPrismaDevServer, type ServerOptions } from "@prisma/dev";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCreateCommand } from "../../src/commands/create";
import type { DatabaseProvider } from "../../src/types";

const TEST_TIMEOUT = Number(process.env.CREATE_PRISMA_E2E_TIMEOUT_MS ?? 180_000);
const MONGO_STARTUP_TIMEOUT = Number(process.env.CREATE_PRISMA_E2E_MONGO_TIMEOUT_MS ?? 60_000);

type DevDatabase = {
  connectionString: string;
  close(): Promise<void>;
};

type GeneratedProject = {
  projectDir: string;
  rootDir: string;
};

const tempRoots: string[] = [];

function normalizePostgresConnectionString(raw: string): string {
  const url = new URL(raw);
  if (url.hostname === "localhost" || url.hostname === "::1") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

async function createDevDatabase(options?: ServerOptions): Promise<DevDatabase> {
  const server = await startPrismaDevServer({
    databaseConnectTimeoutMillis: 1000,
    databaseIdleTimeoutMillis: 1000,
    ...options,
  });

  return {
    connectionString: normalizePostgresConnectionString(server.database.connectionString),
    close: () => server.close(),
  };
}

function buildMongoUri(baseUri: string, dbName: string): string {
  const [hostPart, query] = baseUri.split("?");
  const hostWithSlash = (hostPart ?? "").replace(/\/?$/, "/");
  return query ? `${hostWithSlash}${dbName}?${query}` : `${hostWithSlash}${dbName}`;
}

async function runCommand(projectDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: args,
    cwd: projectDir,
    env: {
      ...process.env,
      CI: "1",
      CREATE_PRISMA_DISABLE_TELEMETRY: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      [`Command failed: ${args.join(" ")}`, `Exit code: ${exitCode}`, stdout, stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return [stdout, stderr].filter(Boolean).join("\n");
}

async function runScript(projectDir: string, scriptName: string): Promise<string> {
  return runCommand(projectDir, ["bun", "run", scriptName]);
}

async function writeDatabaseUrl(projectDir: string, databaseUrl: string): Promise<void> {
  await writeFile(path.join(projectDir, ".env"), `DATABASE_URL=${JSON.stringify(databaseUrl)}\n`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function scaffoldProject(
  provider: DatabaseProvider,
  databaseUrl: string,
): Promise<GeneratedProject> {
  const rootDir = await mkdtemp(path.join(tmpdir(), `create-prisma-e2e-${provider}-`));
  tempRoots.push(rootDir);

  const projectName = `${provider}-app`;
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  try {
    await runCreateCommand({
      name: projectName,
      template: "hono",
      provider,
      authoring: "psl",
      packageManager: "bun",
      databaseUrl,
      prismaPostgres: false,
      install: false,
      emit: false,
      yes: true,
    });
  } finally {
    process.chdir(previousCwd);
  }

  return {
    rootDir,
    projectDir: path.join(rootDir, projectName),
  };
}

async function writeVerificationScript(
  projectDir: string,
  provider: DatabaseProvider,
): Promise<string> {
  const verifyPath = path.join(projectDir, "verify-seed.ts");
  const script =
    provider === "mongo"
      ? `import { db, listUsers } from "./src/lib/prisma";

try {
  const users = await listUsers();
  const emails = users.map((user) => user.email).sort();
  if (users.length !== 3 || emails.join(",") !== "alice@prisma.io,bob@prisma.io,carol@prisma.io") {
    throw new Error(\`Expected 3 seeded users, received \${JSON.stringify(users)}\`);
  }

  const alice = await db.orm.users.where({ email: "alice@prisma.io" }).first();
  if (!alice || alice.name !== "Alice") {
    throw new Error(\`Expected Alice query result, received \${JSON.stringify(alice)}\`);
  }
} finally {
  await db.close();
}
`
      : `import { db, listUsers } from "./src/lib/prisma";

try {
  const users = await listUsers();
  const emails = users.map((user) => user.email).sort();
  if (users.length !== 3 || emails.join(",") !== "alice@prisma.io,bob@prisma.io,carol@prisma.io") {
    throw new Error(\`Expected 3 seeded users, received \${JSON.stringify(users)}\`);
  }

  const alice = await db.orm.User.where({ email: "alice@prisma.io" }).first();
  if (!alice || alice.name !== "Alice") {
    throw new Error(\`Expected Alice query result, received \${JSON.stringify(alice)}\`);
  }
} finally {
  await db.runtime().close();
}
`;

  await writeFile(verifyPath, script);
  return verifyPath;
}

async function installAndEmit(projectDir: string): Promise<void> {
  expect(await pathExists(path.join(projectDir, "prisma-next.md"))).toBe(true);
  expect(await pathExists(path.join(projectDir, "prisma/db.ts"))).toBe(true);
  expect(await pathExists(path.join(projectDir, ".env.example"))).toBe(true);

  await runCommand(projectDir, ["bun", "install"]);
  await runScript(projectDir, "skills:sync");
  expect(await pathExists(path.join(projectDir, ".agents/skills/prisma-next/SKILL.md"))).toBe(true);
  expect(
    await pathExists(path.join(projectDir, ".agents/skills/prisma-next-queries/SKILL.md")),
  ).toBe(true);
  await runScript(projectDir, "contract:emit");
}

async function verifyGeneratedProject(
  projectDir: string,
  provider: DatabaseProvider,
): Promise<void> {
  const verifyPath = await writeVerificationScript(projectDir, provider);
  await runCommand(projectDir, ["bun", verifyPath]);
  await runScript(projectDir, "build");
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const rootDir = tempRoots.pop();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

describe("create-prisma e2e", () => {
  test(
    "postgres runs db init, migrations, seed, generated queries, and build",
    async () => {
      const initDb = await createDevDatabase();
      let project: GeneratedProject | undefined;
      try {
        project = await scaffoldProject("postgres", initDb.connectionString);
        await installAndEmit(project.projectDir);

        await runScript(project.projectDir, "db:init");
        await runScript(project.projectDir, "db:verify");
      } finally {
        await initDb.close();
      }

      expect(project).toBeDefined();
      const migrationDb = await createDevDatabase();
      try {
        await writeDatabaseUrl(project!.projectDir, migrationDb.connectionString);
        await runScript(project!.projectDir, "migration:plan");
        await runScript(project!.projectDir, "migrate");
        await runScript(project!.projectDir, "db:seed");
        await verifyGeneratedProject(project!.projectDir, "postgres");
      } finally {
        await migrationDb.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "mongodb runs migrations, seed, generated queries, and build",
    async () => {
      let replSet: MongoMemoryReplSet | undefined;
      try {
        replSet = await MongoMemoryReplSet.create({
          instanceOpts: [{ launchTimeout: MONGO_STARTUP_TIMEOUT, storageEngine: "wiredTiger" }],
          replSet: { count: 1, storageEngine: "wiredTiger" },
        });
        const databaseUrl = buildMongoUri(replSet.getUri(), "create_prisma_e2e");
        const project = await scaffoldProject("mongo", databaseUrl);

        await installAndEmit(project.projectDir);
        await runScript(project.projectDir, "migration:plan");
        await runScript(project.projectDir, "migrate");
        await runScript(project.projectDir, "db:seed");
        await verifyGeneratedProject(project.projectDir, "mongo");
      } finally {
        await replSet?.stop();
      }
    },
    TEST_TIMEOUT,
  );
});
