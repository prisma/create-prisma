import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CreateFailure } from "../src/create-outcome";
import { applicationRuntime } from "../src/runtime";
import type { CreateCommandInput } from "../src/types";

const clack = await import("@clack/prompts");
const promptedNames: string[] = [];
const text = mock(async () => promptedNames.shift() ?? "unexpected-prompt");
const warn = mock(() => {});

mock.module("@clack/prompts", () => ({
  ...clack,
  text,
  log: { ...clack.log, warn },
}));

const { collectCreateContext } = await import("../src/commands/create-context");

const originalCwd = process.cwd();
let rootDir = "";

beforeEach(async () => {
  rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "create-prisma-context-")));
  process.chdir(rootDir);
  promptedNames.length = 0;
  text.mockClear();
  warn.mockClear();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(rootDir, { recursive: true, force: true });
});

async function seedDirectory(name: string, files: Record<string, string>) {
  const directory = path.join(rootDir, name);
  await mkdir(directory, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    await writeFile(path.join(directory, file), contents);
  }
}

const rejectCreateContext = (input: CreateCommandInput): Promise<CreateFailure> =>
  applicationRuntime.runPromise(
    Effect.flip(collectCreateContext({ json: true, ...input })),
  ) as Promise<CreateFailure>;

describe("non-empty target directory", () => {
  test("points an existing app at orm init instead of --force", async () => {
    await seedDirectory("shop", { "package.json": "{}", "pnpm-lock.yaml": "" });

    const failure = await rejectCreateContext({ name: "shop" });

    expect(failure).toMatchObject({
      stage: "collect_context",
      reason: "target_directory_not_empty",
      targetDirectoryKind: "existing_app",
    });
    expect(failure.message).toContain("`pnpm dlx prisma@latest orm init`");
    expect(failure.message).toContain("https://www.prisma.io/docs/cli/orm-init");
    expect(failure.message).not.toContain("add-to-existing-project/postgresql");
    expect(failure.message).not.toContain("Use --force to continue");
  });

  test.each([
    ["postgres", "postgresql"],
    ["mongo", "mongodb"],
  ] as const)("links the %s guide when the provider is known", async (provider, guide) => {
    await seedDirectory("shop", { "package.json": "{}" });

    const failure = await rejectCreateContext({ name: "shop", provider });

    expect(failure.message).toContain(`add-to-existing-project/${guide}`);
  });

  test("keeps --force as the way to resume an existing Prisma project", async () => {
    await seedDirectory("shop", { "package.json": "{}", "prisma.config.ts": "" });

    const failure = await rejectCreateContext({ name: "shop" });

    expect(failure.targetDirectoryKind).toBe("prisma_project");
    expect(failure.message).toContain("rerun with --force");
    expect(failure.message).not.toContain("orm init");
  });

  test("falls back to a generic message for unrelated files", async () => {
    await seedDirectory("shop", { "notes.txt": "hello" });

    const failure = await rejectCreateContext({ name: "shop" });

    expect(failure.targetDirectoryKind).toBe("other");
    expect(failure.message).toContain("Choose a different project name");
  });

  test("asks for another name when the prompted one is taken", async () => {
    await seedDirectory("taken", { "package.json": "{}" });
    promptedNames.push("taken", "fresh");

    const context = await applicationRuntime.runPromise(
      collectCreateContext({
        template: "minimal",
        provider: "postgres",
        authoring: "psl",
        packageManager: "bun",
        skills: "none",
        deploy: false,
      }),
    );

    expect(context.targetDirectory).toBe(path.join(rootDir, "fresh"));
    expect(text).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("already contains an app");
  });
});
