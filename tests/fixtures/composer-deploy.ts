import { NodeFileSystem } from "@effect/platform-node-shared";
import { Cause, Effect, Exit } from "effect";
import { writeFile } from "node:fs/promises";

import {
  CommandRunner,
  type CommandResult,
  type CommandSpec,
} from "../../src/services/command-runner";
import { runComposerDeployEffect } from "../../src/tasks/composer/deploy-report";

// What the Prisma CLI prints when the delegated Alchemy process exits non-zero.
export const childProcessFailedResult: CommandResult = {
  exitCode: 1,
  stdout: JSON.stringify({
    kind: "result",
    envelope: {
      ok: false,
      commandId: "deploy",
      error: {
        code: "CLI.CHILD_PROCESS_FAILED",
        severity: "error",
        summary: "The delegated process exited with code 1.",
      },
    },
  }),
  stderr: "",
  childProcessFailure: "non_zero_exit",
};

// The file Composer writes to the `--report` path before the CLI settles the run.
export function composerRunReport(failure: { code: string; message: string } | null): string {
  return `${JSON.stringify(
    {
      version: 1,
      outcome: failure ? "failed" : "succeeded",
      app: failure ? null : "my-app",
      stage: null,
      nodes: [],
      failure,
    },
    null,
    2,
  )}\n`;
}

/** Runs the deploy step against a fake Prisma CLI that optionally writes a run report. */
export async function runFakeComposerDeploy(options: { result: CommandResult; report?: string }) {
  const specs: CommandSpec[] = [];
  let reportPath: string | undefined;
  const run = (spec: CommandSpec) =>
    Effect.promise(async () => {
      specs.push(spec);
      const flagIndex = spec.args.indexOf("--report");
      reportPath = flagIndex === -1 ? undefined : spec.args[flagIndex + 1];
      if (reportPath && options.report !== undefined) await writeFile(reportPath, options.report);
      return options.result;
    });

  const exit = await Effect.runPromiseExit(
    runComposerDeployEffect({ packageManager: "npm", projectDir: process.cwd() }).pipe(
      Effect.provideService(CommandRunner, { run, runChecked: run }),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  return {
    specs,
    reportPath,
    result: Exit.isSuccess(exit) ? exit.value : undefined,
    error: Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined,
  };
}
