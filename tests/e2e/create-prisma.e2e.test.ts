import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
      const match = output.match(/app:\s+(http:\/\/localhost:\d+)/);
      if (!match?.[1]) continue;

      const response = await fetch(match[1]);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ users: [] });
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
      expect(packageJson.scripts.deploy).toContain("bun run composer:deploy");
      expect(packageJson.overrides.effect).toBe("4.0.0-beta.103");
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
});
