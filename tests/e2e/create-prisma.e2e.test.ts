import { afterEach, describe, expect, test } from "bun:test";
import { startPrismaDevServer, type ServerOptions } from "@prisma/dev";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCreateCommand } from "../../src/commands/create";
import {
  authoringStyles,
  createTemplates,
  type AuthoringStyle,
  type CreateTemplate,
  type DatabaseProvider,
} from "../../src/types";

const TEST_TIMEOUT = Number(process.env.CREATE_PRISMA_E2E_TIMEOUT_MS ?? 240_000);
const MONGO_STARTUP_TIMEOUT = Number(process.env.CREATE_PRISMA_E2E_MONGO_TIMEOUT_MS ?? 90_000);
const PRISMA_NEXT_VERSION = process.env.CREATE_PRISMA_E2E_PRISMA_NEXT_VERSION;

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
  return runCommand(projectDir, ["npm", "run", scriptName], extraEnv);
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
  authoring: AuthoringStyle;
  databaseUrl?: string;
}): Promise<GeneratedProject> {
  const { template, provider, authoring, databaseUrl } = opts;
  const rootDir = await mkdtemp(
    path.join(tmpdir(), `create-prisma-e2e-${template}-${provider}-${authoring}-`),
  );
  tempRoots.push(rootDir);

  const projectName = `${template}-${provider}-${authoring}-app`;
  const previousCwd = process.cwd();
  process.chdir(rootDir);
  try {
    await runCreateCommand({
      name: projectName,
      template,
      provider,
      authoring,
      packageManager: "npm",
      databaseUrl,
      prismaPostgres: false,
      install: false,
      emit: false,
      prismaNextVersion: PRISMA_NEXT_VERSION,
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

function getPrismaModuleSpecifier(_template: CreateTemplate): string {
  return "./src/prisma/users";
}

async function writeVerificationScript(
  projectDir: string,
  template: CreateTemplate,
  provider: DatabaseProvider,
): Promise<string> {
  const verifyPath = path.join(projectDir, "verify-seed.ts");
  const modulePath = getPrismaModuleSpecifier(template);
  const closeCall = "await db.close();";
  const aliceQuery =
    provider === "mongo"
      ? 'await db.orm.users.where({ email: "alice@prisma.io" }).first()'
      : 'await db.orm.public.User.where({ email: "alice@prisma.io" }).first()';

  const script = `import "dotenv/config";
import { db, listUsers } from "${modulePath}";

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
  expect(await pathExists(path.join(projectDir, "src/prisma/db.ts"))).toBe(true);
  expect(await pathExists(path.join(projectDir, "prisma"))).toBe(false);
  expect(await pathExists(path.join(projectDir, ".env.example"))).toBe(true);

  await runCommand(projectDir, ["npm", "install"]);
  await runScript(projectDir, "contract:emit");
}

async function verifyGeneratedProject(
  projectDir: string,
  template: CreateTemplate,
  provider: DatabaseProvider,
): Promise<void> {
  const verifyPath = await writeVerificationScript(projectDir, template, provider);
  await runCommand(projectDir, [path.join(projectDir, "node_modules/.bin/tsx"), verifyPath]);

  switch (template) {
    case "minimal":
      return;
    case "next":
      await runScript(projectDir, "lint");
      await runScript(projectDir, "build");
      return;
    case "svelte":
      await runScript(projectDir, "check");
      await runScript(projectDir, "build");
      return;
    case "nuxt":
    case "tanstack-start":
      await runScript(projectDir, "typecheck");
      await runScript(projectDir, "build");
      return;
    default:
      await runScript(projectDir, "build");
  }
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

describe("create-prisma e2e", () => {
  test(
    "accepts a positional project name",
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-e2e-positional-"));
      tempRoots.push(rootDir);

      const projectName = "positional-app";
      await runCommand(rootDir, [
        "bun",
        path.join(process.cwd(), "src/cli.ts"),
        projectName,
        "--yes",
        "--template",
        "minimal",
        "--provider",
        "mongo",
        "--package-manager",
        "bun",
        "--no-install",
        "--no-emit",
        ...(PRISMA_NEXT_VERSION ? ["--prisma-next-version", PRISMA_NEXT_VERSION] : []),
      ]);

      const projectDir = path.join(rootDir, projectName);
      expect(await pathExists(path.join(projectDir, "package.json"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "src/prisma/db.ts"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "prisma"))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  for (const template of createTemplates) {
    for (const authoring of authoringStyles) {
      test(
        `${template} + postgres + ${authoring} runs db init, migrations, seed, generated queries, and validation`,
        async () => {
          const initDb = await createDevDatabase();
          let project: GeneratedProject | undefined;
          try {
            project = await scaffoldProject({
              template,
              provider: "postgres",
              authoring,
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
        `${template} + mongo + ${authoring} provisions in-memory mongo and validates the app`,
        async () => {
          const project = await scaffoldProject({ template, provider: "mongo", authoring });

          expect(await pathExists(path.join(project.projectDir, "scripts/mongo.mjs"))).toBe(true);
          const mongoScript = await readFile(
            path.join(project.projectDir, "scripts/mongo.mjs"),
            "utf8",
          );
          expect(mongoScript).toStartWith('import { spawn } from "node:child_process";');
          const pkgJson = await readJsonFile(path.join(project.projectDir, "package.json"));
          const scriptsPkg = pkgJson.scripts as Record<string, string> | undefined;
          expect(scriptsPkg?.["db:up"]).toBe("node --env-file=.env scripts/mongo.mjs up");
          expect(scriptsPkg?.["db:down"]).toBe("node --env-file=.env scripts/mongo.mjs down");
          expect(scriptsPkg?.["db:reset"]).toBe("node --env-file=.env scripts/mongo.mjs reset");
          const devDeps = pkgJson.devDependencies as Record<string, string> | undefined;
          expect(devDeps?.["mongodb-memory-server"]).toBeDefined();
          expect(await pathExists(path.join(project.projectDir, "docker-compose.yml"))).toBe(false);

          await installAndEmit(project.projectDir);

          const mongo = await startMemoryMongo(project.projectDir);
          try {
            expect(await pathExists(path.join(project.projectDir, ".mongo-data", "db"))).toBe(true);
            expect(
              await pathExists(path.join(project.projectDir, ".mongo-data", "mongo.log")),
            ).toBe(true);
            expect(
              await pathExists(path.join(project.projectDir, ".mongo-data", "mongo.pid")),
            ).toBe(true);

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
  }
});
