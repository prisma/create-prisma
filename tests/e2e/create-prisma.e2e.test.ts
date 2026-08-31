import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCreateCommand } from "../../src/commands/create";
import type { CreateCommandResult } from "../../src/result";
import { scaffoldCreateTemplate } from "../../src/templates/render-create-template";
import { writeCreateTemplateDependencies, writePrismaDependencies } from "../../src/tasks/install";

const TEST_TIMEOUT = Number(process.env.CREATE_PRISMA_E2E_TIMEOUT_MS ?? 300_000);
const tempRoots: string[] = [];

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(projectDir: string, args: string[]) {
  const process = Bun.spawn({
    cmd: args,
    cwd: projectDir,
    env: { ...Bun.env, CI: "1", CREATE_PRISMA_DISABLE_TELEMETRY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error([`Command failed: ${args.join(" ")}`, stdout, stderr].join("\n"));
  }
  return `${stdout}\n${stderr}`;
}

async function runCreatePrismaJson(rootDir: string, args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "../../src/cli.ts"), "create", ...args],
    cwd: rootDir,
    env: { ...Bun.env, CI: "1", CREATE_PRISMA_DISABLE_TELEMETRY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let result: CreateCommandResult;
  try {
    result = JSON.parse(stdout) as CreateCommandResult;
  } catch (error) {
    throw new Error(
      [
        `Could not parse create-prisma JSON output (exit ${exitCode}).`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join("\n"),
      { cause: error },
    );
  }
  return {
    result,
    stderr,
    stdout,
    exitCode,
  };
}

function findAppEndpoint(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    try {
      const frame = JSON.parse(line) as { kind?: unknown; name?: unknown; url?: unknown };
      if (frame.kind === "endpoint" && frame.name === "app" && typeof frame.url === "string") {
        return frame.url;
      }
    } catch {
      // Build output and package-manager prefixes are not JSON protocol frames.
    }
  }
}

async function fetchUntilReady(url: string, deadline: number): Promise<Response> {
  while (true) {
    try {
      const response = await fetch(url);
      if (response.status === 200 || Date.now() >= deadline) return response;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await Bun.sleep(1_000);
  }
}

async function verifyComposerDev(projectDir: string) {
  const process = Bun.spawn({
    cmd: ["bun", "run", "dev:composer"],
    cwd: projectDir,
    env: { ...Bun.env, CI: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const readers = [process.stdout.getReader(), process.stderr.getReader()];
  const pending = readers.map((reader, index) =>
    reader.read().then((result) => ({ index, result })),
  );
  const decoder = new TextDecoder();
  let output = "";
  let activeReaders = readers.length;
  const deadline = Date.now() + 120_000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Timed out waiting for Composer dev.")), 120_000);
  });

  try {
    while (Date.now() < deadline) {
      const { index, result } = await Promise.race([...pending, timeout]);
      if (result.done) {
        activeReaders -= 1;
        pending[index] = new Promise(() => {});
        if (activeReaders === 0) break;
        continue;
      } else {
        output += decoder.decode(result.value, { stream: true });
        pending[index] = readers[index]!.read().then((nextResult) => ({
          index,
          result: nextResult,
        }));
      }
      const appUrl = findAppEndpoint(output);
      if (!appUrl) continue;

      // The endpoint frame can precede the app process binding its port, so
      // retry connection refusals until the deadline.
      const response = await fetchUntilReady(appUrl, deadline);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { users: Array<{ name: string }> };
      expect(body.users.map((user) => user.name)).toEqual(["Alice", "Bob", "Carol"]);
      return;
    }
  } finally {
    clearTimeout(timeoutId);
    process.kill();
    await process.exited;
  }

  throw new Error(`Composer dev exited before becoming ready.\n${output}`);
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("create-prisma e2e", () => {
  test("returns a non-zero exit code when project setup fails", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-exit-code-e2e-"));
    tempRoots.push(rootDir);
    const emptyBinDir = path.join(rootDir, "empty-bin");
    await mkdir(emptyBinDir);

    const child = Bun.spawn({
      cmd: [
        process.execPath,
        path.join(import.meta.dir, "../../src/cli.ts"),
        "create",
        "failed-app",
        "--template",
        "minimal",
        "--provider",
        "postgres",
        "--authoring",
        "psl",
        "--package-manager",
        "npm",
        "--no-deploy",
        "--yes",
        "--json",
      ],
      cwd: rootDir,
      env: {
        ...Bun.env,
        PATH: emptyBinDir,
        CI: "1",
        CREATE_PRISMA_DISABLE_TELEMETRY: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { stage: "initialize_prisma" },
    });
    expect(stderr).toBe("");
    expect(await pathExists(path.join(rootDir, "failed-app", "package.json"))).toBe(true);
  });

  test("rejects unsupported Deno combinations with a non-zero exit code", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-deno-reject-e2e-"));
    tempRoots.push(rootDir);

    const child = Bun.spawn({
      cmd: [
        process.execPath,
        path.join(import.meta.dir, "../../src/cli.ts"),
        "create",
        "unsupported-deno-app",
        "--template",
        "next",
        "--provider",
        "postgres",
        "--authoring",
        "psl",
        "--package-manager",
        "deno",
        "--no-deploy",
        "--json",
      ],
      cwd: rootDir,
      env: { ...Bun.env, CI: "1", CREATE_PRISMA_DISABLE_TELEMETRY: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        stage: "collect_context",
        message: "Deno support currently requires the minimal template.",
      },
    });
    expect(stderr).toBe("");
    expect(await pathExists(path.join(rootDir, "unsupported-deno-app"))).toBe(false);
  });

  test("returns structured JSON for invalid arguments", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-json-invalid-e2e-"));
    tempRoots.push(rootDir);

    const { result, stderr, stdout, exitCode } = await runCreatePrismaJson(rootDir, [
      "invalid-app",
      "--template",
      "not-a-template",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(result).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { stage: "parse_arguments" },
    });
  });

  test("keeps JSON mode deterministic by rejecting verbose output", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-json-verbose-e2e-"));
    tempRoots.push(rootDir);

    const { result, stderr, stdout, exitCode } = await runCreatePrismaJson(rootDir, [
      "verbose-app",
      "--json",
      "--verbose",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        stage: "validate_input",
        message: "--verbose cannot be used with --json because JSON mode is output-only.",
      },
    });
  });

  test(
    "generates, builds, and runs a Composer-backed Prisma Postgres app",
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-next-e2e-"));
      tempRoots.push(rootDir);
      const appName = `composer-app-${path.basename(rootDir).toLowerCase()}`;
      const { result, stdout, exitCode } = await runCreatePrismaJson(rootDir, [
        appName,
        "--template",
        "minimal",
        "--provider",
        "postgres",
        "--authoring",
        "psl",
        "--package-manager",
        "bun",
        "--no-deploy",
        "--json",
      ]);

      const projectDir = path.join(rootDir, appName);
      expect(exitCode).toBe(0);
      expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
      expect(result).toMatchObject({
        schemaVersion: 1,
        ok: true,
        project: {
          name: appName,
          path: await realpath(projectDir),
          template: "minimal",
          databaseProvider: "postgres",
          authoring: "psl",
          packageManager: "bun",
        },
        deployment: null,
        nextSteps: [
          {
            command: `cd ${appName}`,
            description: "Enter your new project directory.",
          },
          {
            command: "bun run dev:composer",
            description: "Build and start the app with Prisma Composer locally.",
          },
          {
            command: "bun run deploy",
            description: "Build and deploy the app with Prisma Composer.",
          },
        ],
      });
      expect(result.ok && Array.isArray(result.warnings)).toBe(true);
      const packageJson = JSON.parse(
        await readFile(path.join(projectDir, "package.json"), "utf8"),
      ) as Record<string, any>;
      const moduleSource = await readFile(path.join(projectDir, "module.ts"), "utf8");
      const dbSource = await readFile(path.join(projectDir, "src/prisma/db.ts"), "utf8");

      expect(await pathExists(path.join(projectDir, "src/prisma/contract.json"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "prisma.config.ts"))).toBe(true);
      // The scaffold commits the baseline migration — replay-only deploys
      // need an authored path from empty to the contract.
      expect(await pathExists(path.join(projectDir, "migrations/app"))).toBe(true);
      expect(
        await pathExists(path.join(projectDir, ".agents/skills/prisma-composer/SKILL.md")),
      ).toBe(true);
      expect(
        await pathExists(path.join(projectDir, ".claude/skills/prisma-composer/SKILL.md")),
      ).toBe(true);
      expect(packageJson.devDependencies.prisma).toBe("latest");
      expect(packageJson.scripts.postinstall).toBe("prisma skills sync || exit 0");
      expect(packageJson.scripts.deploy).toContain("bun run composer:deploy");
      expect(packageJson.overrides.effect).toBe("4.0.0-rc.112");
      expect(moduleSource).toContain("postgres({");
      expect(dbSource).toContain("service.load().database.client");

      await runCommand(projectDir, ["bun", "run", "build"]);
      await runCommand(projectDir, ["bunx", "tsc", "--noEmit"]);
      await verifyComposerDev(projectDir);
    },
    TEST_TIMEOUT,
  );

  test(
    "builds a Next.js app with a TypeScript-authored contract",
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-next-typescript-e2e-"));
      tempRoots.push(rootDir);
      const previousCwd = process.cwd();
      process.chdir(rootDir);
      try {
        await runCreateCommand({
          name: "next-typescript-app",
          template: "next",
          provider: "postgres",
          authoring: "typescript",
          packageManager: "bun",
          deploy: false,
          yes: true,
        });
      } finally {
        process.chdir(previousCwd);
      }

      const projectDir = path.join(rootDir, "next-typescript-app");
      const composerSource = await readFile(
        path.join(projectDir, "src/prisma/composer.ts"),
        "utf8",
      );
      const dbSource = await readFile(path.join(projectDir, "src/prisma/db.ts"), "utf8");

      expect(composerSource).toContain(
        'import type { Contract } from "./generated/contract.d.ts";',
      );
      expect(dbSource).toContain('import type { Contract } from "./generated/contract.d.ts";');
      expect(await pathExists(path.join(projectDir, "src/prisma/generated/contract.json"))).toBe(
        true,
      );
      expect(await pathExists(path.join(projectDir, "src/prisma/generated/contract.d.ts"))).toBe(
        true,
      );
      expect(await pathExists(path.join(projectDir, "prisma.config.ts"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "migrations/app"))).toBe(true);
      expect(
        await pathExists(path.join(projectDir, ".agents/skills/prisma-composer/SKILL.md")),
      ).toBe(true);
      expect(
        await pathExists(path.join(projectDir, ".claude/skills/prisma-composer/SKILL.md")),
      ).toBe(true);

      await runCommand(projectDir, ["bun", "run", "build"]);
      await runCommand(projectDir, ["bunx", "tsc", "--noEmit"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "builds the generated Nest template with npm",
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-nest-npm-e2e-"));
      tempRoots.push(rootDir);
      const projectDir = path.join(rootDir, "nest-npm-app");
      await mkdir(projectDir);
      await scaffoldCreateTemplate({
        projectDir,
        projectName: "nest-npm-app",
        template: "nest",
        provider: "postgres",
        authoring: "psl",
        packageManager: "npm",
      });
      await writePrismaDependencies("postgres", "npm", "psl", projectDir);
      await writeCreateTemplateDependencies({
        template: "nest",
        packageManager: "npm",
        projectDir,
      });
      await writeFile(path.join(projectDir, "src/prisma/contract.json"), "{}\n");
      await writeFile(
        path.join(projectDir, "src/prisma/contract.d.ts"),
        "export type Contract = never;\n",
      );

      const packageJson = JSON.parse(
        await readFile(path.join(projectDir, "package.json"), "utf8"),
      ) as Record<string, any>;

      expect(packageJson.scripts.build).toBe("tsdown");
      expect(packageJson.devDependencies.tsdown).toBeDefined();
      expect(packageJson.devDependencies.esbuild).toBeUndefined();
      expect(await pathExists(path.join(projectDir, "tsdown.config.ts"))).toBe(true);

      await runCommand(projectDir, ["bun", "install", "--ignore-scripts"]);
      await runCommand(projectDir, ["npm", "run", "build"]);
      expect(await pathExists(path.join(projectDir, "dist/server.mjs"))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "generates and checks a minimal Deno Prisma Postgres app",
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-deno-e2e-"));
      tempRoots.push(rootDir);
      const previousCwd = process.cwd();
      process.chdir(rootDir);
      try {
        await runCreateCommand({
          name: "deno-app",
          template: "minimal",
          provider: "postgres",
          authoring: "psl",
          packageManager: "deno",
          deploy: false,
          yes: true,
        });
      } finally {
        process.chdir(previousCwd);
      }

      const projectDir = path.join(rootDir, "deno-app");
      const packageJson = JSON.parse(
        await readFile(path.join(projectDir, "package.json"), "utf8"),
      ) as Record<string, any>;
      const configSource = await readFile(path.join(projectDir, "prisma.config.ts"), "utf8");
      const dbSource = await readFile(path.join(projectDir, "src/prisma/db.ts"), "utf8");

      expect(await pathExists(path.join(projectDir, "deno.json"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "src/prisma/contract.json"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "src/prisma/contract.d.ts"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "prisma-next.md"))).toBe(false);
      expect(await pathExists(path.join(projectDir, "module.ts"))).toBe(false);
      expect(await pathExists(path.join(projectDir, "service.ts"))).toBe(false);
      expect(await pathExists(path.join(projectDir, "prisma-next.config.ts"))).toBe(false);
      expect(configSource).toContain("dotenv/config");
      expect(dbSource).toContain('Deno.env.get("DATABASE_URL")');
      expect(packageJson.scripts).toMatchObject({
        build: "deno check src/index.ts",
        dev: "deno run -A --env-file=.env --watch src/index.ts",
      });
      expect(packageJson.scripts.deploy).toBeUndefined();

      await runCommand(projectDir, ["deno", "task", "build"]);
    },
    TEST_TIMEOUT,
  );
});
