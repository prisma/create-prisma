import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCreateCommand } from "../../src/commands/create";

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

      const response = await fetch(appUrl);
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

    const exitCode = await child.exited;
    expect(exitCode).toBe(1);
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
        "--yes",
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
    expect(`${stdout}\n${stderr}`).toContain(
      "Deno support currently requires the minimal template",
    );
    expect(await pathExists(path.join(rootDir, "unsupported-deno-app"))).toBe(false);
  });

  test(
    "generates, builds, and runs a Composer-backed Prisma Postgres app",
    async () => {
      const rootDir = await mkdtemp(path.join(tmpdir(), "create-prisma-next-e2e-"));
      tempRoots.push(rootDir);
      const previousCwd = process.cwd();
      process.chdir(rootDir);
      try {
        await runCreateCommand({
          name: "composer-app",
          template: "minimal",
          provider: "postgres",
          authoring: "psl",
          packageManager: "bun",
          deploy: false,
          yes: true,
        });
      } finally {
        process.chdir(previousCwd);
      }

      const projectDir = path.join(rootDir, "composer-app");
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
      expect(packageJson.devDependencies.prisma).toBe("next");
      expect(packageJson.scripts.postinstall).toBe("prisma skills sync || exit 0");
      expect(packageJson.scripts.deploy).toContain("bun run composer:deploy");
      expect(packageJson.overrides.effect).toBe("4.0.0-rc.111");
      expect(moduleSource).toContain("pnPostgres({");
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

      await runCommand(projectDir, ["bun", "run", "build"]);
      await runCommand(projectDir, ["bunx", "tsc", "--noEmit"]);
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
      const configSource = await readFile(path.join(projectDir, "prisma-next.config.ts"), "utf8");
      const dbSource = await readFile(path.join(projectDir, "src/prisma/db.ts"), "utf8");

      expect(await pathExists(path.join(projectDir, "deno.json"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "src/prisma/contract.json"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "src/prisma/contract.d.ts"))).toBe(true);
      expect(await pathExists(path.join(projectDir, "prisma-next.md"))).toBe(false);
      expect(await pathExists(path.join(projectDir, "module.ts"))).toBe(false);
      expect(await pathExists(path.join(projectDir, "service.ts"))).toBe(false);
      expect(await pathExists(path.join(projectDir, "prisma.config.ts"))).toBe(false);
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
