import { Context, Effect, Layer, Schema } from "effect";
import { execa } from "execa";
import { createInterface } from "node:readline";

export type CommandSpec = {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit";
  onStderrLine?: (line: string) => void;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class CommandExecutionError extends Schema.TaggedError<CommandExecutionError>()(
  "CommandExecutionError",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
    stdout: Schema.String,
    stderr: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.stderr.trim() || this.stdout.trim();
    const invocation = [this.command, ...this.args].join(" ");
    return (
      detail ||
      `Command failed${this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`}: ${invocation}`
    );
  }
}

export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    run(spec: CommandSpec): Effect.Effect<CommandResult, CommandExecutionError>;
    runChecked(spec: CommandSpec): Effect.Effect<CommandResult, CommandExecutionError>;
  }
>()("create-prisma/services/CommandRunner") {
  static readonly layer = Layer.sync(CommandRunner, () => {
    const run = Effect.fn("CommandRunner.run")((spec: CommandSpec) =>
      Effect.tryPromise({
        try: async (signal) => {
          const subprocess = execa(spec.command, [...spec.args], {
            cwd: spec.cwd,
            env: spec.env,
            stdio: spec.stdio ?? "pipe",
            reject: false,
            cancelSignal: signal,
          });
          const stderr = subprocess.stderr;

          const stderrLines =
            spec.onStderrLine && stderr
              ? (async () => {
                  const lines = createInterface({ input: stderr });
                  for await (const line of lines) {
                    if (line.trim()) spec.onStderrLine?.(line);
                  }
                })()
              : Promise.resolve();

          const [result] = await Promise.all([subprocess, stderrLines]);
          return {
            exitCode: result.exitCode ?? 1,
            stdout: typeof result.stdout === "string" ? result.stdout : "",
            stderr: typeof result.stderr === "string" ? result.stderr : "",
          };
        },
        catch: (cause) =>
          new CommandExecutionError({
            command: spec.command,
            args: [...spec.args],
            stdout: "",
            stderr: "",
            cause,
          }),
      }),
    );
    const runChecked = Effect.fn("CommandRunner.runChecked")((spec: CommandSpec) =>
      Effect.flatMap(run(spec), (result) =>
        result.exitCode === 0
          ? Effect.succeed(result)
          : Effect.fail(
              new CommandExecutionError({
                command: spec.command,
                args: [...spec.args],
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
              }),
            ),
      ),
    );
    return CommandRunner.of({ run, runChecked });
  });
}
