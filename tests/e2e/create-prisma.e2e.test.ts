import { afterEach, describe, expect, test } from "bun:test";
import { startPrismaDevServer, type ServerOptions } from "@prisma/dev";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCreateCommand } from "../../src/commands/create";
import type { CreateTemplate, DatabaseProvider } from "../../src/types";

const TEST_TIMEOUT = Number(process.env.CREATE_PRISMA_E2E_TIMEOUT_MS ?? 240_000);
const MONGO_STARTUP_TIMEOUT = Number(process.env.CREATE_PRISMA_E2E_MONGO_TIMEOUT_MS ?? 90_000);

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

async function runCommand(
  projectDir: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn({
    cmd: args,
    cwd: projectDir,
    env: {
      ...process.env,
      CI: "1",
      CREATE_PRISMA_DISABLE_TELEMETRY: "1",
      ...extraEnv,
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

async function runScript(
  projectDir: string,
  scriptName: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return runCommand(projectDir, ["bun", "run", scriptName], extraEnv);
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

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function scaffoldProject(opts: {
  template: CreateTemplate;
  provider: DatabaseProvider;
  databaseUrl?: string;
}): Promise<GeneratedProject> {
  const { template, provider, databaseUrl } = opts;
  const rootDir = await mkdtemp(path.join(tmpdir(), `create-prisma-e2e-${template}-${provider}-`));
  tempRoots.push(rootDir);

  const projectName = `${template}-${provider}-app`;
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  try {
    await runCreateCommand({
      name: projectName,
      template,
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

function getPrismaModuleSpecifier(template: CreateTemplate): string {
  switch (template) {
    case "nuxt":
      return "./server/utils/prisma";
    case "svelte":
      return "./src/lib/server/prisma";
    case "tanstack-start":
      return "./src/lib/prisma.server";
    default:
      return "./src/lib/prisma";
  }
}

async function writeVerificationScript(
  projectDir: string,
  template: CreateTemplate,
  provider: DatabaseProvider,
): Promise<string> {
  const verifyPath = path.join(projectDir, "verify-seed.ts");
  const modulePath = getPrismaModuleSpecifier(template);
  const closeCall = provider === "mongo" ? "await db.close();" : "await db.runtime().close();";
  const aliceQuery =
    provider === "mongo"
      ? 'await db.orm.users.where({ email: "alice@prisma.io" }).first()'
      : 'await db.orm.User.where({ email: "alice@prisma.io" }).first()';

  const script = `import { db, listUsers } from "${modulePath}";

try {
  const users = await listUsers();
  const emails = users.map((user) => user.email).sort();
  if (users.length !== 3 || emails.join(",") !== "alice@prisma.io,bob@prisma.io,carol@prisma.io") {
    throw new Error(\`Expected 3 seeded users, received \${JSON.stringify(users)}\`);
  }

  const alice = ${aliceQuery};
  if (!alice || alice.name !== "Alice" || alice.username !== "alice") {
    throw new Error(\`Expected Alice query result, received \${JSON.stringify(alice)}\`);
  }
} finally {
  ${closeCall}
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
  await runScript(projectDir, "contract:emit");
}

async function verifyGeneratedProject(
  projectDir: string,
  template: CreateTemplate,
  provider: DatabaseProvider,
): Promise<void> {
  const verifyPath = await writeVerificationScript(projectDir, template, provider);
  await runCommand(projectDir, ["bun", verifyPath]);
  await runScript(projectDir, "build");
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("Could not determine free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

type MemoryMongoHandle = {
  port: number;
  stop: () => Promise<void>;
};

async function startMemoryMongo(projectDir: string): Promise<MemoryMongoHandle> {
  const port = await getFreePort();
  await writeDatabaseUrl(
    projectDir,
    `mongodb://localhost:${port}/mydb?replicaSet=rs0&directConnection=true`,
  );
  // db:up is detached and exits when ready, so this returns once the server is listening.
  await runScript(projectDir, "db:up", {
    MONGO_READY_TIMEOUT_MS: String(MONGO_STARTUP_TIMEOUT),
  });
  return {
    port,
    stop: async () => {
      try {
        await runScript(projectDir, "db:down");
      } catch {
        // best-effort cleanup
      }
    },
  };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const rootDir = tempRoots.pop();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

const templates: CreateTemplate[] = ["hono", "next"];

describe("create-prisma e2e", () => {
  for (const template of templates) {
    test(
      `${template} + postgres runs db init, migrations, seed, generated queries, and build`,
      async () => {
        const initDb = await createDevDatabase();
        let project: GeneratedProject | undefined;
        try {
          project = await scaffoldProject({
            template,
            provider: "postgres",
            databaseUrl: initDb.connectionString,
          });
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
          await verifyGeneratedProject(project!.projectDir, template, "postgres");
        } finally {
          await migrationDb.close();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      `${template} + mongo provisions in-memory mongo via generated db:up`,
      async () => {
        const project = await scaffoldProject({ template, provider: "mongo" });

        expect(await pathExists(path.join(project.projectDir, "scripts/mongo.mjs"))).toBe(true);
        const pkgJson = await readJsonFile(path.join(project.projectDir, "package.json"));
        const scriptsPkg = pkgJson.scripts as Record<string, string> | undefined;
        expect(scriptsPkg?.["db:up"]).toContain("scripts/mongo.mjs up");
        expect(scriptsPkg?.["db:down"]).toContain("scripts/mongo.mjs down");
        expect(scriptsPkg?.["db:reset"]).toContain("scripts/mongo.mjs reset");
        const devDeps = pkgJson.devDependencies as Record<string, string> | undefined;
        expect(devDeps?.["mongodb-memory-server"]).toBeDefined();
        expect(await pathExists(path.join(project.projectDir, "docker-compose.yml"))).toBe(false);

        await installAndEmit(project.projectDir);

        const mongo = await startMemoryMongo(project.projectDir);
        try {
          expect(await pathExists(path.join(project.projectDir, ".mongo-data", "db"))).toBe(true);
          expect(await pathExists(path.join(project.projectDir, ".mongo-data", "mongo.log"))).toBe(
            true,
          );
          expect(await pathExists(path.join(project.projectDir, ".mongo-data", "mongo.pid"))).toBe(
            true,
          );

          await runScript(project.projectDir, "migration:plan");
          await runScript(project.projectDir, "migrate");
          await runScript(project.projectDir, "db:seed");
          await verifyGeneratedProject(project.projectDir, template, "mongo");
        } finally {
          await mongo.stop();
        }
      },
      TEST_TIMEOUT,
    );
  }
});
