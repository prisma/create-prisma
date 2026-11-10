import { expect, test } from "bun:test";
import { Effect } from "effect";

import { CommandExecutionError, CommandRunner } from "../src/services/command-runner";
import { getComposerDevBunWarningEffect } from "../src/tasks/composer/dev-bun";
import { showsComposerDevStep } from "../src/tasks/prisma-setup/presentation";
import type { PrismaSetupContext } from "../src/tasks/prisma-setup/types";

function warningWith(run: CommandRunner["Service"]["run"]) {
  return Effect.runPromise(
    getComposerDevBunWarningEffect(process.cwd(), "npm").pipe(
      Effect.provideService(CommandRunner, { run, runChecked: run }),
    ),
  );
}

const bunPrints =
  (stdout: string, exitCode = 0) =>
  () =>
    Effect.succeed({ exitCode, stdout, stderr: "" });

test("warns when the local Bun is older than 1.3.14", async () => {
  const warning = await warningWith(bunPrints("1.3.13\n"));
  expect(warning).toContain("Bun 1.3.13 is on your PATH.");
  expect(warning).toContain("Run `bun upgrade` before `npm run dev:composer`.");
});

test("accepts Bun 1.3.14 and newer", async () => {
  expect(await warningWith(bunPrints("1.3.14\n"))).toBeUndefined();
  expect(await warningWith(bunPrints("1.4.4\n"))).toBeUndefined();
});

test("warns when Bun is not installed", async () => {
  const missing = () =>
    Effect.fail(
      new CommandExecutionError({
        command: "bun",
        args: ["--version"],
        stdout: "",
        stderr: "",
        childProcessFailure: "command_not_found",
      }),
    );
  expect(await warningWith(missing)).toContain("Bun is not on your PATH.");
  expect(
    await warningWith(() =>
      Effect.succeed({
        exitCode: 1,
        stdout: "",
        stderr: "",
        childProcessFailure: "command_not_found" as const,
      }),
    ),
  ).toContain("Bun is not on your PATH.");
});

test("stays silent when Bun's version cannot be read", async () => {
  expect(await warningWith(bunPrints("not a version\n"))).toBeUndefined();
  expect(await warningWith(bunPrints("", 1))).toBeUndefined();
  expect(
    await warningWith(() =>
      Effect.fail(
        new CommandExecutionError({
          command: "bun",
          args: ["--version"],
          stdout: "",
          stderr: "",
          childProcessFailure: "permission_denied",
        }),
      ),
    ),
  ).toBeUndefined();
});

test("gives up when bun --version hangs", async () => {
  expect(await warningWith(() => Effect.never)).toBeUndefined();
}, 10_000);

test("checks Bun only when the next steps include Composer dev", () => {
  const context = (packageManager: PrismaSetupContext["packageManager"]) =>
    ({ packageManager }) as PrismaSetupContext;
  expect(showsComposerDevStep(context("npm"), { includeDevNextStep: true })).toBe(true);
  expect(showsComposerDevStep(context("npm"), {})).toBe(false);
  expect(showsComposerDevStep(context("deno"), { includeDevNextStep: true })).toBe(false);
});
