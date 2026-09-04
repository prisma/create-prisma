import { Effect, Schema } from "effect";

import { PrismaCliCommandError } from "../../create-outcome";
import { CommandRunner } from "../../services/command-runner";
import type { PackageManager } from "../../types";
import { getErrorMessage } from "../../utils/errors";
import { getLocalPackageBinaryArgs } from "../../utils/package-manager";

const PrismaCliEnvelopeSchema = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.optionalKey(Schema.String),
  commandId: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      summary: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      why: Schema.optionalKey(Schema.String),
    }),
  ),
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
  onStderrLine?: (line: string) => void;
}) {
  const runner = yield* CommandRunner;
  const invocation = getLocalPackageBinaryArgs(options.packageManager, "prisma", [
    ...options.args,
    "--json",
    "--no-interactive",
  ]);
  const result = yield* runner.run({
    command: invocation.command,
    args: invocation.args,
    cwd: options.projectDir,
    env: process.env,
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
  });

  let envelope: PrismaCliEnvelope;
  try {
    envelope = parsePrismaCliEnvelope(result.stdout);
  } catch (cause) {
    return yield* new PrismaCliCommandError({
      message: result.stderr.trim() || getErrorMessage(cause),
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  if (result.exitCode !== 0 || !envelope.ok || envelope.result === undefined) {
    const summary = envelope.error?.summary ?? envelope.error?.message;
    return yield* new PrismaCliCommandError({
      message:
        [summary, envelope.error?.why].filter(Boolean).join(": ") ||
        result.stderr.trim() ||
        "Prisma CLI command failed.",
      ...(envelope.commandId || envelope.command
        ? { command: envelope.commandId ?? envelope.command }
        : {}),
      ...(envelope.error?.code ? { code: envelope.error.code } : {}),
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return envelope.result;
});

export const decodePrismaCommandResult = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new PrismaCliCommandError({
          message: `Prisma CLI returned an invalid result: ${cause.message}`,
        }),
    ),
  );

export { PrismaCliCommandError } from "../../create-outcome";
