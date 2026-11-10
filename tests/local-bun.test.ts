import { expect, test } from "bun:test";
import { Effect } from "effect";

import { CommandExecutionError, CommandRunner } from "../src/services/command-runner";
import { checkLocalBunEffect } from "../src/tasks/prisma-setup/local-bun";

function checkWith(run: CommandRunner["Service"]["run"]) {
  return Effect.runPromise(
    checkLocalBunEffect(process.cwd()).pipe(
      Effect.provideService(CommandRunner, { run, runChecked: run }),
    ),
  );
}

const bunVersion = (stdout: string) => () => Effect.succeed({ exitCode: 0, stdout, stderr: "" });

test("warns when the local Bun is older than 1.3.14", async () => {
  expect(await checkWith(bunVersion("1.3.13\n"))).toContain("Bun 1.3.13 is on your PATH.");
});

test("accepts Bun 1.3.14 and newer", async () => {
  expect(await checkWith(bunVersion("1.3.14\n"))).toBeUndefined();
  expect(await checkWith(bunVersion("1.4.4\n"))).toBeUndefined();
});

test("stays silent when Bun is missing or prints no version", async () => {
  expect(
    await checkWith(() =>
      Effect.fail(
        new CommandExecutionError({ command: "bun", args: ["--version"], stdout: "", stderr: "" }),
      ),
    ),
  ).toBeUndefined();
  expect(
    await checkWith(() => Effect.succeed({ exitCode: 127, stdout: "", stderr: "not found" })),
  ).toBeUndefined();
});
