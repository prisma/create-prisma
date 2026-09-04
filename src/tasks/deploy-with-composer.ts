import { log, spinner, taskLog } from "@clack/prompts";
import { Cause, Effect, Exit } from "effect";
import type { Writable } from "node:stream";

import {
  CreateCancellationError,
  CreateFailure,
  type CreateFailureReason,
  type CreateFailureStage,
} from "../create-outcome";
import type { ComposerDeployResult } from "../result";
import { applicationRuntime } from "../runtime";
import type { PackageManager } from "../types";
import { getErrorMessage, redactSecrets } from "../utils/errors";
import { getLocalPackageBinaryCommand, getRunScriptArgs } from "../utils/package-manager";
import { runSetupCommand } from "../utils/run-command";
import { atCreateStage } from "../workflow/failure";
import { ensureAuthentication, selectDeploymentWorkspace } from "./composer/auth";
import {
  ComposerDeployCommandResultSchema,
  parseComposerDeployResult,
} from "./composer/deployment-result";
import { decodePrismaCommandResult, runPrismaJsonCommandEffect } from "./composer/prisma-cli";
import { ensureProjectNameAvailable, getProjectDetails } from "./composer/projects";

export type ComposerDeployExecutionResult =
  | { ok: true; deployment: ComposerDeployResult }
  | { ok: false; cancelled: true; stage: "select_workspace" }
  | {
      ok: false;
      cancelled?: false;
      stage: CreateFailureStage;
      reason: CreateFailureReason;
      error: unknown;
    };

type DeployOptions = {
  appName: string;
  packageManager: PackageManager;
  projectDir: string;
  shouldPromptForWorkspace: boolean;
  verbose: boolean;
  output?: Writable;
  allowInteractiveLogin?: boolean;
  json?: boolean;
  workspace?: string;
};

export const deployNewProjectWithComposerEffect = Effect.fn("Deployment.deploy")(function* (
  options: DeployOptions,
) {
  const output = options.output ?? process.stdout;
  const progress = options.verbose ? undefined : spinner({ output });
  let deploymentLog: ReturnType<typeof taskLog> | undefined;
  let progressRunning = false;
  const showProgress = (message: string) => {
    if (!progress) return;
    if (progressRunning) progress.message(message);
    else {
      progress.start(message);
      progressRunning = true;
    }
  };
  const clearProgress = () => {
    if (!progress || !progressRunning) return;
    progress.clear();
    progressRunning = false;
  };

  const program = Effect.gen(function* () {
    yield* Effect.sync(() => {
      showProgress("Checking Prisma account...");
      if (options.verbose) log.step("Checking Prisma account.", { output });
    });
    const authState = yield* atCreateStage(
      ensureAuthentication({
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        output,
        allowInteractiveLogin: options.allowInteractiveLogin ?? true,
        beforeInteractiveLogin: clearProgress,
      }),
      "authenticate",
      "prisma_auth_command_failed",
    );

    yield* Effect.sync(() => {
      showProgress("Checking Prisma workspace...");
      if (options.verbose) log.step("Checking Prisma workspace.", { output });
    });
    const selectedWorkspace = yield* atCreateStage(
      selectDeploymentWorkspace({
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        shouldPrompt: options.shouldPromptForWorkspace,
        authState,
        output,
        beforePrompt: clearProgress,
        afterPrompt: () => showProgress("Selecting Prisma workspace..."),
        ...(options.workspace ? { workspace: options.workspace } : {}),
      }),
      "select_workspace",
      "workspace_selection_failed",
    );

    yield* Effect.sync(() => {
      showProgress("Checking Prisma project name...");
      if (options.verbose) log.step("Checking Prisma project name.", { output });
    });
    yield* atCreateStage(
      ensureProjectNameAvailable({
        appName: options.appName,
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        workspace: selectedWorkspace,
      }),
      "check_project_name",
      "project_lookup_failed",
    );

    yield* Effect.sync(() => {
      showProgress("Building for deployment...");
      if (options.verbose) log.step("Building for deployment.", { output });
    });
    const build = getRunScriptArgs(options.packageManager, "build");
    yield* atCreateStage(
      runSetupCommand({
        command: build.command,
        args: build.args,
        cwd: options.projectDir,
        env: process.env,
        verbose: options.verbose,
        json: options.json === true,
      }),
      "build",
      "build_failed",
    );

    const deployCommand = getLocalPackageBinaryCommand(options.packageManager, "prisma", [
      "deploy",
      "module.ts",
    ]);
    yield* Effect.sync(() => {
      clearProgress();
      if (options.verbose) log.step(`Deploying to Prisma with ${deployCommand}.`, { output });
      else {
        deploymentLog = taskLog({ title: "Deploying to Prisma...", limit: 10, output });
        deploymentLog.message(`$ ${deployCommand}`);
      }
    });
    const rawDeployment = yield* atCreateStage(
      runPrismaJsonCommandEffect({
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        args: ["deploy", "module.ts"],
        onStderrLine: (line) => {
          const redacted = redactSecrets(line);
          if (options.verbose) output.write(`${redacted}\n`);
          else deploymentLog?.message(redacted);
        },
      }),
      "composer_deploy",
      "composer_deploy_failed",
    );
    const deploymentResult = yield* atCreateStage(
      decodePrismaCommandResult(ComposerDeployCommandResultSchema, rawDeployment),
      "composer_deploy",
      "composer_deploy_failed",
    );
    const deployment = parseComposerDeployResult(deploymentResult);
    const appName = deployment?.appName ?? options.appName;

    yield* Effect.sync(() => {
      if (options.verbose) log.step("Loading deployment details.", { output });
      else deploymentLog?.message("Loading deployment details...");
    });
    const details = yield* getProjectDetails({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      appName,
    });
    yield* Effect.sync(() => {
      deploymentLog?.success("Deployed to Prisma.");
      deploymentLog = undefined;
      progressRunning = false;
      if (options.verbose) log.success("Deployed to Prisma.", { output });
    });

    return {
      appName,
      ...(deployment?.appUrl ? { appUrl: deployment.appUrl } : {}),
      ...(deployment?.serviceId ? { serviceId: deployment.serviceId } : {}),
      workspace: details?.workspace ?? selectedWorkspace,
      project: details?.project ?? { name: appName },
    } satisfies ComposerDeployResult;
  });

  return yield* program.pipe(
    Effect.tapCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause);
        if (deploymentLog) {
          deploymentLog.error("Deployment failed.");
          deploymentLog = undefined;
        } else {
          progress?.error("Deployment failed.");
        }
        progressRunning = false;
        if (!(error instanceof CreateCancellationError)) {
          log.error(`Deploy failed: ${getErrorMessage(error)}`, { output });
        }
      }),
    ),
    Effect.mapError((error) =>
      error instanceof CreateFailure
        ? new CreateFailure({
            stage: error.stage,
            reason: error.reason,
            message: error.message,
            cause: error.cause,
            errorReported: true,
          })
        : error,
    ),
  );
});

export async function deployNewProjectWithComposer(
  options: DeployOptions,
): Promise<ComposerDeployExecutionResult> {
  const exit = await applicationRuntime.runPromiseExit(deployNewProjectWithComposerEffect(options));
  if (Exit.isSuccess(exit)) {
    return {
      ok: true,
      deployment: exit.value,
    };
  }

  const failureReason = exit.cause.reasons.find(Cause.isFailReason);
  const error = failureReason?.error ?? Cause.squash(exit.cause);
  if (error instanceof CreateCancellationError) {
    return { ok: false, cancelled: true, stage: "select_workspace" };
  }
  const failure =
    error instanceof CreateFailure
      ? error
      : new CreateFailure({
          stage: "unknown",
          reason: "unexpected_error",
          message: getErrorMessage(error),
          cause: error,
        });
  return {
    ok: false,
    stage: failure.stage,
    reason: failure.reason,
    error: failure.cause ?? failure,
  };
}

export { parseComposerDeployResult } from "./composer/deployment-result";
export { parsePrismaCliEnvelope, PrismaCliCommandError } from "./composer/prisma-cli";
export { findProjectNameCollisions, getConsoleProjectUrl } from "./composer/projects";
export type { ComposerDeployResult } from "../result";
