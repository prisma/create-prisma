import { Effect, FileSystem, Option, Schema } from "effect";
import path from "node:path";

import { isStructuredErrorCode, PrismaCliCommandError } from "../../create-outcome";
import type { PackageManager } from "../../types";
import { runPrismaJsonCommandEffect } from "../prisma-cli";

// `prisma deploy --report <path>` writes the deploy's outcome before the CLI
// settles a failed child process as the generic `CLI.CHILD_PROCESS_FAILED`.
// Only the failure code is read; the message can contain local paths.
const ComposerRunReportSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    failure: Schema.NullOr(Schema.Struct({ code: Schema.String })),
  }),
);
const decodeComposerRunReport = Schema.decodeUnknownOption(ComposerRunReportSchema);

export function parseComposerDeployFailureCode(report: string): string | undefined {
  const code = Option.getOrUndefined(decodeComposerRunReport(report))?.failure?.code;
  return isStructuredErrorCode(code) ? code : undefined;
}

function withCauseCode(error: PrismaCliCommandError, causeCode: string): PrismaCliCommandError {
  return new PrismaCliCommandError({
    message: error.message,
    ...(error.command === undefined ? {} : { command: error.command }),
    ...(error.code === undefined ? {} : { code: error.code }),
    causeCode,
    ...(error.stderr === undefined ? {} : { stderr: error.stderr }),
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    childProcessFailure: error.childProcessFailure,
  });
}

const readComposerDeployFailureCode = Effect.fn("Deployment.readFailureCode")(function* (
  reportPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // A deploy that never reached Composer leaves no report behind.
  const report = yield* fs.readFileString(reportPath).pipe(Effect.option);
  return Option.isSome(report) ? parseComposerDeployFailureCode(report.value) : undefined;
});

export const runComposerDeployEffect = Effect.fn("Deployment.runComposerDeploy")(
  function* (options: {
    packageManager: PackageManager;
    projectDir: string;
    onStderrLine?: (line: string) => void;
  }) {
    const fs = yield* FileSystem.FileSystem;
    // The report is diagnostic only, so a missing temp directory must not block the deploy.
    const reportPath = yield* fs.makeTempDirectoryScoped({ prefix: "create-prisma-deploy-" }).pipe(
      Effect.map((directory) => path.join(directory, "report.json")),
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );

    return yield* runPrismaJsonCommandEffect({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      args: ["deploy", "module.ts", ...(reportPath ? ["--report", reportPath] : [])],
      ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
    }).pipe(
      Effect.catchTag("PrismaCliCommandError", (error) =>
        Effect.gen(function* () {
          const causeCode = reportPath
            ? yield* readComposerDeployFailureCode(reportPath)
            : undefined;
          return yield* Effect.fail(causeCode ? withCauseCode(error, causeCode) : error);
        }),
      ),
    );
  },
  Effect.scoped,
);
