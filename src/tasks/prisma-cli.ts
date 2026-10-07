import { Effect, Schema } from "effect";

import { PrismaCliCommandError } from "../create-outcome";
import { CommandExecutionError, CommandRunner } from "../services/command-runner";
import type { PackageManager } from "../types";
import { getErrorMessage, redactSecrets } from "../utils/errors";
import { getLocalPackageBinaryArgs, getPackageExecutionArgs } from "../utils/package-manager";

const PrismaCliDiagnosticSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  why: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Schema.Literals(["error", "warn", "info"])),
});

const PrismaCliEnvelopeSchema = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.optionalKey(Schema.String),
  commandId: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(PrismaCliDiagnosticSchema),
  diagnostics: Schema.optionalKey(Schema.Array(PrismaCliDiagnosticSchema)),
});
type PrismaCliEnvelope = typeof PrismaCliEnvelopeSchema.Type;
const decodePrismaCliEnvelope = Schema.decodeUnknownExit(PrismaCliEnvelopeSchema);

export function parsePrismaCliEnvelope(output: string): PrismaCliEnvelope {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const candidate = parsed.kind === "result" ? parsed.envelope : parsed;
      const decoded = decodePrismaCliEnvelope(candidate);
      if (decoded._tag === "Success") return decoded.value;
    } catch {
      // Prisma may emit progress frames before the terminal JSON envelope.
    }
  }
  throw new Error("Prisma CLI returned output that is not a valid result envelope.");
}

export const runPrismaJsonCommandEffect = Effect.fn("PrismaCli.runJson")(function* (options: {
  packageManager: PackageManager;
  projectDir: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  onStderrLine?: (line: string) => void;
  interactive?: boolean;
  cliPackage?: string;
}) {
  const runner = yield* CommandRunner;
  const args = [...options.args, "--json", ...(options.interactive ? [] : ["--no-interactive"])];
  const invocation = options.cliPackage
    ? getPackageExecutionArgs(options.packageManager, [options.cliPackage, ...args])
    : getLocalPackageBinaryArgs(options.packageManager, "prisma", args);
  const result = yield* runner.run({
    command: invocation.command,
    args: invocation.args,
    cwd: options.projectDir,
    env: options.env ?? process.env,
    ...(options.interactive ? { stdio: ["inherit", "pipe", "inherit"] as const } : {}),
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
  });

  let envelope: PrismaCliEnvelope;
  try {
    envelope = parsePrismaCliEnvelope(result.stdout);
  } catch (cause) {
    return yield* new PrismaCliCommandError({
      message:
        redactSecrets(result.stderr.trim() || result.stdout.trim()) || getErrorMessage(cause),
      stderr: redactSecrets(result.stderr),
      exitCode: result.exitCode,
      childProcessFailure: result.childProcessFailure,
    });
  }

  if (result.exitCode !== 0 || !envelope.ok || envelope.result === undefined) {
    const failure =
      envelope.error ?? envelope.diagnostics?.find((diagnostic) => diagnostic.severity === "error");
    const summary = failure?.summary ?? failure?.message;
    return yield* new PrismaCliCommandError({
      message: redactSecrets(
        [summary, failure?.why].filter(Boolean).join(": ") ||
          result.stderr.trim() ||
          "Prisma CLI command failed.",
      ),
      ...(envelope.commandId || envelope.command
        ? { command: envelope.commandId ?? envelope.command }
        : {}),
      ...(failure?.code ? { code: failure.code } : {}),
      stderr: redactSecrets(result.stderr),
      exitCode: result.exitCode,
      childProcessFailure: result.childProcessFailure,
    });
  }
  return envelope.result;
});

export function isPrismaCliCancellation(error: unknown): boolean {
  if (!(error instanceof PrismaCliCommandError || error instanceof CommandExecutionError))
    return false;
  return (
    error.childProcessFailure === "interrupted" ||
    error.childProcessFailure === "cancelled" ||
    (error instanceof PrismaCliCommandError &&
      [
        "AUTH.LOGIN_DENIED",
        "CLI.PROMPT_CANCELLED",
        "CLI.ABORTED",
        "CLI.INIT_USER_ABORTED",
      ].includes(error.code ?? ""))
  );
}

export const decodePrismaCommandResult = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new PrismaCliCommandError({
          message: `Prisma CLI returned an invalid result: ${cause.message}`,
        }),
    ),
  );

export { PrismaCliCommandError } from "../create-outcome";
