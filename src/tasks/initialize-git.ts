import { Effect, FileSystem, Result } from "effect";
import path from "node:path";

import { applicationRuntime } from "../runtime";
import { CommandRunner } from "../services/command-runner";
import { getErrorMessage } from "../utils/errors";

export type GitInitializationResult =
  | { status: "initialized" }
  | { status: "already-in-repository" }
  | { status: "skipped"; reason: string };

export const initializeGitRepositoryEffect = Effect.fn("Git.initialize")(function* (
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const runner = yield* CommandRunner;
  const fs = yield* FileSystem.FileSystem;
  const existing = yield* runner
    .run({ command: "git", args: ["rev-parse", "--is-inside-work-tree"], cwd: projectDir, env })
    .pipe(Effect.result);

  if (Result.isFailure(existing)) {
    return {
      status: "skipped",
      reason: getErrorMessage(existing.failure),
    } satisfies GitInitializationResult;
  }
  if (existing.success.exitCode === 0 && existing.success.stdout.trim() === "true") {
    return { status: "already-in-repository" } satisfies GitInitializationResult;
  }

  const initialize = Effect.gen(function* () {
    yield* runner.runChecked({ command: "git", args: ["init"], cwd: projectDir, env });
    yield* runner.runChecked({ command: "git", args: ["add", "--all"], cwd: projectDir, env });
    yield* runner.runChecked({
      command: "git",
      args: ["commit", "--no-verify", "-m", "Initial commit from create-prisma"],
      cwd: projectDir,
      env,
    });
    return { status: "initialized" } satisfies GitInitializationResult;
  });

  return yield* initialize.pipe(
    Effect.catch((error) =>
      fs.remove(path.join(projectDir, ".git"), { recursive: true, force: true }).pipe(
        Effect.catch(() => Effect.void),
        Effect.as({
          status: "skipped",
          reason: getErrorMessage(error),
        } satisfies GitInitializationResult),
      ),
    ),
  );
});

export function initializeGitRepository(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitInitializationResult> {
  return applicationRuntime.runPromise(initializeGitRepositoryEffect(projectDir, env));
}
