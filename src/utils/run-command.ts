import { Effect } from "effect";

import { CommandRunner } from "../services/command-runner";

export const runSetupCommand = Effect.fn("runSetupCommand")(function* (options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  verbose: boolean;
  json: boolean;
}) {
  const runner = yield* CommandRunner;
  const shouldInheritOutput = options.verbose && !options.json;
  yield* runner.runChecked({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    stdio: shouldInheritOutput ? "inherit" : "pipe",
  });
});
