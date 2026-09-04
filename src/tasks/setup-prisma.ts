import { cancel, log, note, outro, spinner } from "@clack/prompts";
import { Effect } from "effect";
import path from "node:path";

import { CreateCancellationError, CreateFailure } from "../create-outcome";
import { applicationRuntime } from "../runtime";
import { scaffoldCreateSharedTemplatesEffect } from "../templates/render-create-template";
import type { CreateTemplate, PrismaSetupCommandInput } from "../types";
import { getErrorMessage } from "../utils/errors";
import { getInstallCommand } from "../utils/package-manager";
import { atCreateStage } from "../workflow/failure";
import { deployNewProjectWithComposerEffect } from "./deploy-with-composer";
import { initializeGitRepositoryEffect, type GitInitializationResult } from "./initialize-git";
import { installProjectDependenciesEffect, writePrismaDependenciesEffect } from "./install";
import { initializeAgentSkills, runPrismaCli, runPrismaInit } from "./prisma-setup/commands";
import { collectPrismaSetupContextEffect } from "./prisma-setup/context";
import {
  ensureComposerTypeScriptOptions,
  ensureGitignoreEntry,
  ensureMongoEnvironment,
} from "./prisma-setup/project-files";
import { buildNextSteps, formatNextSteps, formatProjectSummary } from "./prisma-setup/presentation";
import type {
  PrismaSetupContext,
  PrismaSetupRunOptions,
  PrismaSetupSuccess,
} from "./prisma-setup/types";

export const executePrismaSetupContextEffect = Effect.fn("PrismaSetup.execute")(function* (
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
) {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const projectName = options.projectName ?? path.basename(projectDir);
  const template = options.template ?? "minimal";
  const progress = context.verbose
    ? undefined
    : (options.progressSpinner ?? spinner({ output: context.output }));
  const ownsProgress = progress !== undefined && !options.progressSpinner;
  let gitInitialization: GitInitializationResult | undefined;
  if (ownsProgress) yield* Effect.sync(() => progress.start("Creating Prisma 8 project..."));

  const setup = Effect.gen(function* () {
    yield* atCreateStage(
      writePrismaDependenciesEffect(
        context.databaseProvider,
        context.packageManager,
        context.authoring,
        projectDir,
      ),
      "configure_project",
      "project_configuration_failed",
    );

    yield* Effect.sync(() =>
      progress?.message(
        `Installing dependencies with ${getInstallCommand(context.packageManager)}...`,
      ),
    );
    yield* atCreateStage(
      installProjectDependenciesEffect(context.packageManager, projectDir, {
        verbose: context.verbose,
        json: context.json,
      }),
      "install_dependencies",
      "dependency_install_failed",
    );

    yield* Effect.sync(() => progress?.message("Preparing Prisma 8 project files..."));
    yield* atCreateStage(
      runPrismaInit(context, projectDir),
      "initialize_prisma",
      "prisma_init_failed",
    );

    yield* atCreateStage(
      Effect.gen(function* () {
        yield* scaffoldCreateSharedTemplatesEffect({
          projectDir,
          projectName,
          template,
          provider: context.databaseProvider,
          authoring: context.authoring,
          packageManager: context.packageManager,
        });
        yield* ensureComposerTypeScriptOptions(projectDir);
        if (context.databaseProvider === "mongo") yield* ensureMongoEnvironment(projectDir);
        if (context.packageManager !== "deno") {
          yield* ensureGitignoreEntry(projectDir, "/.alchemy");
          yield* ensureGitignoreEntry(projectDir, "/.prisma-composer");
        }
      }),
      "configure_project",
      "project_configuration_failed",
    );

    yield* Effect.sync(() => progress?.message("Installing Prisma agent skills..."));
    yield* atCreateStage(
      initializeAgentSkills(context, projectDir),
      "initialize_agent_skills",
      "agent_skills_init_failed",
    );

    yield* Effect.sync(() => progress?.message("Generating Prisma 8 contract artifacts..."));
    yield* atCreateStage(
      runPrismaCli(context, projectDir, ["contract", "emit"]),
      "emit_contract",
      "contract_emit_failed",
    );

    if (context.databaseProvider === "postgres") {
      yield* Effect.sync(() => progress?.message("Authoring the baseline migration..."));
      yield* atCreateStage(
        runPrismaCli(context, projectDir, ["migration", "plan", "--name", "init"]),
        "plan_migration",
        "migration_plan_failed",
      );
    }

    if (options.initializeGit) {
      yield* Effect.sync(() => progress?.message("Initializing Git repository..."));
      gitInitialization = yield* atCreateStage(
        initializeGitRepositoryEffect(projectDir),
        "initialize_git",
        "git_initialization_failed",
      );
    }
  });

  yield* setup.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        progress?.stop("Prisma 8 project ready.");
        if (gitInitialization?.status === "initialized" && context.verbose) {
          log.success("Initialized Git repository with an initial commit.", {
            output: context.output,
          });
        } else if (gitInitialization?.status === "skipped") {
          log.warn(`Could not initialize Git repository: ${gitInitialization.reason}`, {
            output: context.output,
          });
        }
      }),
    ),
    Effect.tapError((error) =>
      Effect.sync(() => {
        progress?.error("Could not create Prisma 8 project.");
        if (!(error instanceof CreateCancellationError)) {
          cancel(getErrorMessage(error), { output: context.output });
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

  const deployment = context.shouldDeploy
    ? yield* deployNewProjectWithComposerEffect({
        appName: projectName,
        packageManager: context.packageManager,
        projectDir,
        shouldPromptForWorkspace: context.shouldPromptForWorkspace,
        verbose: context.verbose,
        output: context.output,
        allowInteractiveLogin: !context.json,
        json: context.json,
        ...(context.workspace ? { workspace: context.workspace } : {}),
      })
    : null;

  const nextSteps = buildNextSteps(context, options);
  const warnings =
    gitInitialization?.status === "skipped"
      ? [`Could not initialize Git repository: ${gitInitialization.reason}`]
      : [];
  const projectSummary = formatProjectSummary({
    createdProjectPath: options.createdProjectPath,
    ...(deployment ? { deployment } : {}),
  });
  yield* Effect.sync(() => {
    if (projectSummary) {
      note(projectSummary, context.shouldDeploy ? "Deployment" : "Project", {
        output: context.output,
      });
    }
    note(formatNextSteps(nextSteps), "Next steps", { output: context.output });
    outro(context.shouldDeploy ? "Prisma 8 app deployed." : "Prisma 8 project ready.", {
      output: context.output,
    });
  });
  return {
    deployment,
    nextSteps,
    ...(gitInitialization ? { gitInitialization } : {}),
    warnings,
  } satisfies PrismaSetupSuccess;
});

export function collectPrismaSetupContext(
  input: PrismaSetupCommandInput,
  options: { projectDir?: string; template?: CreateTemplate } = {},
): Promise<PrismaSetupContext> {
  return applicationRuntime.runPromise(collectPrismaSetupContextEffect(input, options));
}

export function executePrismaSetupContext(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
): Promise<PrismaSetupSuccess> {
  return applicationRuntime.runPromise(executePrismaSetupContextEffect(context, options));
}

export { collectPrismaSetupContextEffect } from "./prisma-setup/context";
export type {
  PrismaSetupContext,
  PrismaSetupRunOptions,
  PrismaSetupSuccess,
} from "./prisma-setup/types";
