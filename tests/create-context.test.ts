import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CreateCancellationError, type CreateFailure } from "../src/create-outcome";
import { CommandRunner } from "../src/services/command-runner";
import { runCreateCommandEffect } from "../src/commands/create";
import { applicationRuntime } from "../src/runtime";
import type { CreateCommandInput } from "../src/types";

const clack = await import("@clack/prompts");
const promptedNames: string[] = [];
const choices: string[] = [];
const text = mock(
  async (options: { initialValue?: string }) =>
    promptedNames.shift() ?? options.initialValue ?? "unexpected-prompt",
);
const select = mock(async (options: { message?: string; options?: { value: string }[] }) => {
  if (options.message === "What would you like to do?") return choices.shift() ?? "create";
  throw new Error(`Unexpected prompt: ${options.message}`);
});
const warn = mock(() => {});

mock.module("@clack/prompts", () => ({
  ...clack,
  text,
  select,
  log: { ...clack.log, warn },
}));

const { collectCreateContext } = await import("../src/commands/create-context");

const originalCwd = process.cwd();
const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
let rootDir = "";

beforeEach(async () => {
  rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "create-prisma-context-")));
  process.chdir(rootDir);
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  promptedNames.length = 0;
  choices.length = 0;
  text.mockClear();
  select.mockClear();
  warn.mockClear();
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalTTY) Object.defineProperty(process.stdin, "isTTY", originalTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
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

const interactiveInput = {
  template: "minimal",
  provider: "postgres",
  authoring: "psl",
  packageManager: "bun",
  skills: "none",
  deploy: false,
} satisfies CreateCommandInput;

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
    choices.push("rename");

    const context = await applicationRuntime.runPromise(collectCreateContext(interactiveInput));

    expect(context.targetDirectory).toBe(path.join(rootDir, "fresh"));
    expect(text).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Directory "taken" is not empty.');
  });

  test("suggests a free default and skips occupied files when incrementing", async () => {
    await seedDirectory("my-app", { "package.json": "{}" });
    await writeFile(path.join(rootDir, "my-app-1"), "keep me");
    const suggested = await applicationRuntime.runPromise(collectCreateContext(interactiveInput));
    expect(suggested.targetDirectory).toBe(path.join(rootDir, "my-app-2"));
    expect(select).not.toHaveBeenCalled();
    const selected = await applicationRuntime.runPromise(
      collectCreateContext({ ...interactiveInput, name: "my-app" }),
    );
    expect(selected.targetDirectory).toBe(path.join(rootDir, "my-app-2"));
    expect(select.mock.calls[0]?.[0].options?.[0]).toMatchObject({
      value: "create",
      label: 'Create "my-app-2"',
    });
    expect(await readFile(path.join(rootDir, "my-app-1"), "utf8")).toBe("keep me");
  });

  test("cancel leaves the app untouched and existing Prisma projects cannot be initialized from the menu", async () => {
    await seedDirectory("app", { "package.json": "{}", "prisma.config.ts": "keep me" });
    choices.push("cancel");
    const error = await applicationRuntime.runPromise(
      Effect.flip(collectCreateContext({ ...interactiveInput, name: "app" })),
    );
    expect(error).toBeInstanceOf(CreateCancellationError);
    expect(error).toMatchObject({ stage: "directory_conflict" });
    expect(select.mock.calls[0]?.[0].options?.map((option) => option.value)).not.toContain(
      "orm_init",
    );
    expect(await readFile(path.join(rootDir, "app", "prisma.config.ts"), "utf8")).toBe("keep me");
  });

  test("adding Prisma delegates only ORM init without starter files or deployment", async () => {
    const manifest = '{"name":"shop","private":true,"packageManager":"bun@1.4.1"}';
    await seedDirectory("shop", { "package.json": manifest, "index.ts": "keep me" });
    choices.push("orm_init");
    const commands: string[][] = [];
    const result = await applicationRuntime.runPromise(
      runCreateCommandEffect({
        ...interactiveInput,
        name: "shop",
        template: "next",
        deploy: true,
      }).pipe(
        Effect.provideService(CommandRunner, {
          runChecked: (spec) => {
            expect(spec.cwd).toBe(path.join(rootDir, "shop"));
            expect(spec.args).toEqual(["--version"]);
            return Effect.succeed({ exitCode: 0, stdout: "1.4.1", stderr: "" });
          },
          run: (spec) => {
            commands.push([...spec.args]);
            expect(spec.command).toBe("bunx");
            expect(spec.stdio).toEqual(["inherit", "pipe", "inherit"]);
            expect(spec.args).toEqual([
              "prisma@latest",
              "orm",
              "init",
              "--target",
              "postgres",
              "--authoring",
              "psl",
              "--json",
            ]);
            return Effect.succeed({
              exitCode: 0,
              stdout: JSON.stringify({ ok: true, result: { nextSteps: [], warnings: [] } }),
              stderr: "",
            });
          },
        }),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      operation: "orm_init",
      project: { name: "shop", path: path.join(rootDir, "shop") },
    });
    expect(commands).toHaveLength(1);
    expect(result.project).not.toHaveProperty("template");
    expect(await readFile(path.join(rootDir, "shop", "package.json"), "utf8")).toBe(manifest);
    expect(await readFile(path.join(rootDir, "shop", "index.ts"), "utf8")).toBe("keep me");
  });
});
