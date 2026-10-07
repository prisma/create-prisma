import { cancel, intro, log, note, outro, spinner } from "@clack/prompts";
import { Cause, Clock, Effect, Exit, Option, Ref, Schema } from "effect";

import { CreateCancellationError, CreateFailure } from "../create-outcome";
import {
  CREATE_PRISMA_RESULT_SCHEMA_VERSION,
  createCommandFailureResult,
  type CreateCommandResult,
  type CreateNextStep,
} from "../result";
import { applicationRuntime } from "../runtime";
import {
  trackCreateCancelledEffect,
  trackCreateCompletedEffect,
  trackCreateFailedEffect,
} from "../telemetry/create";
import { scaffoldCreateFrameworkTemplateEffect } from "../templates/render-create-template";
import { writeCreateTemplateDependenciesEffect } from "../tasks/install";
import { executePrismaSetupContextEffect } from "../tasks/setup-prisma";
import { runExistingPrismaInit } from "../tasks/prisma-setup/commands";
import { decodePrismaCommandResult } from "../tasks/prisma-cli";
import { decodeCreateCommandInput, type CreateCommandInput } from "../types";
import { getCreatePrismaIntro } from "../ui/branding";
import { resolveExecutionSettings } from "../ui/output";
import { getErrorMessage } from "../utils/errors";
import { getUnsupportedNodeMessage, supportsPrisma } from "../utils/node-version";
import { verifyPackageManagerEffect } from "../utils/package-manager";
import { atCreateStage } from "../workflow/failure";
import {
  collectCreateContext,
  createProjectResult,
  formatPathForDisplay,
  type CreatePromptContext,
  type CreateContext,
  type ExistingAppContext,
} from "./create-context";

const InitGuidanceSchema = Schema.Struct({
  nextSteps: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
});

const initializeExistingApp = Effect.fn("Create.initExisting")(function* (
  context: ExistingAppContext,
  input: CreateCommandInput,
) {
  const { output } = resolveExecutionSettings(input);
  yield* Effect.sync(() =>
    log.step(`Initializing Prisma in ${formatPathForDisplay(context.targetDirectory)}...`, {
      output,
    }),
  );
  const initialization = yield* atCreateStage(
    runExistingPrismaInit(context, input),
    "initialize_prisma",
    "prisma_init_failed",
  );
  const guidance = yield* atCreateStage(
    decodePrismaCommandResult(InitGuidanceSchema, initialization),
    "initialize_prisma",
    "prisma_init_failed",
  );
  yield* Effect.sync(() => {
    for (const warning of guidance.warnings) log.warn(warning, { output });
    if (guidance.nextSteps.length > 0)
      note(guidance.nextSteps.join("\n"), "Next steps", { output });
    outro("Prisma initialized in your existing app.", { output });
  });
  return {
    schemaVersion: CREATE_PRISMA_RESULT_SCHEMA_VERSION,
    ok: true,
    operation: "orm_init",
    project: { name: context.projectPackageName, path: context.targetDirectory },
    initialization,
  } satisfies CreateCommandResult;
});

const executeCreateContext = Effect.fn("Create.execute")(function* (context: CreatePromptContext) {
  const output = context.prismaSetupContext.output;
  const createSpinner = context.prismaSetupContext.verbose ? undefined : spinner({ output });
  yield* Effect.sync(() => {
    createSpinner?.start("Creating Prisma 8 project...");
    if (context.prismaSetupContext.verbose) {
      log.step(`Scaffolding ${context.template} starter.`, { output });
    }
  });

  yield* atCreateStage(
    scaffoldCreateFrameworkTemplateEffect({
      projectDir: context.targetDirectory,
      projectName: context.projectPackageName,
      template: context.template,
      provider: context.prismaSetupContext.databaseProvider,
      authoring: context.prismaSetupContext.authoring,
      packageManager: context.prismaSetupContext.packageManager,
      skillAgents: context.prismaSetupContext.skillAgents,
    }).pipe(
      Effect.andThen(
        writeCreateTemplateDependenciesEffect({
          template: context.template,
          packageManager: context.prismaSetupContext.packageManager,
          projectDir: context.targetDirectory,
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          if (context.prismaSetupContext.verbose) {
            log.success("Starter files scaffolded.", { output });
          }
        }),
      ),
      Effect.tapError(() =>
        Effect.sync(() => createSpinner?.error("Could not create Prisma 8 project.")),
      ),
    ),
    "scaffold_template",
    "template_scaffold_failed",
  );

  const forceWarning =
    context.targetPathState.exists && !context.targetPathState.isEmptyDirectory && context.force
      ? `Used --force in non-empty directory ${formatPathForDisplay(context.targetDirectory)}.`
      : undefined;
  if (forceWarning) yield* Effect.sync(() => log.warn(forceWarning, { output }));
  const nextSteps: CreateNextStep[] =
    formatPathForDisplay(context.targetDirectory) === "."
      ? []
      : [
          {
            command: `cd ${formatPathForDisplay(context.targetDirectory)}`,
            description: "Enter your new project directory.",
          },
        ];

  const setup = yield* executePrismaSetupContextEffect(context.prismaSetupContext, {
    prependNextSteps: nextSteps,
    projectDir: context.targetDirectory,
    projectName: context.projectPackageName,
    template: context.template,
    createdProjectPath: context.targetDirectory,
    includeDevNextStep: true,
    force: context.force,
    initializeGit: !context.targetPathState.exists || context.targetPathState.isEmptyDirectory,
    progressSpinner: createSpinner,
  });
  const warnings = [...setup.warnings];
  if (forceWarning) warnings.unshift(forceWarning);
  return {
    schemaVersion: CREATE_PRISMA_RESULT_SCHEMA_VERSION,
    ok: true,
    project: createProjectResult(context),
    deployment: setup.deployment,
    nextSteps: setup.nextSteps,
    warnings,
  } satisfies CreateCommandResult;
});

const createProjectEffect = Effect.fn("Create.project")(function* (
  rawInput: CreateCommandInput,
  inputRef: Ref.Ref<CreateCommandInput>,
  contextRef: Ref.Ref<Option.Option<CreateContext>>,
) {
  const input = yield* decodeCreateCommandInput(rawInput).pipe(
    Effect.mapError(
      (cause) =>
        new CreateFailure({
          stage: "validate_input",
          reason: "invalid_input",
          message: cause.message,
          cause,
        }),
    ),
  );
  yield* Ref.set(inputRef, input);
  const { output } = resolveExecutionSettings(input);
  if (input.json && input.verbose) {
    return yield* new CreateFailure({
      stage: "validate_input",
      reason: "invalid_input",
      message: "--verbose cannot be used with --json because JSON mode is output-only.",
    });
  }
  if (!supportsPrisma()) {
    const message = getUnsupportedNodeMessage();
    yield* Effect.sync(() => cancel(message, { output }));
    return yield* new CreateFailure({
      stage: "validate_input",
      reason: "unsupported_node_version",
      message,
      errorReported: true,
    });
  }

  yield* Effect.sync(() => intro(getCreatePrismaIntro(), { output }));
  const context = yield* atCreateStage(
    collectCreateContext(input),
    "collect_context",
    "unexpected_error",
  );
  yield* Ref.set(contextRef, Option.some(context));
  yield* atCreateStage(
    context.operation === "orm_init"
      ? verifyPackageManagerEffect(context.packageManager, context.targetDirectory)
      : verifyPackageManagerEffect(context.prismaSetupContext.packageManager),
    "validate_input",
    "package_manager_check_failed",
  );
  return {
    input,
    context,
    result:
      context.operation === "orm_init"
        ? yield* initializeExistingApp(context, input)
        : yield* executeCreateContext(context),
  };
});

export const runCreateCommandEffect = Effect.fn("Create.run")(function* (
  rawInput: CreateCommandInput = {},
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const inputRef = yield* Ref.make<CreateCommandInput>(rawInput);
  const contextRef = yield* Ref.make<Option.Option<CreateContext>>(Option.none());
  const exit = yield* Effect.exit(createProjectEffect(rawInput, inputRef, contextRef));
  const durationMs = (yield* Clock.currentTimeMillis) - startedAt;

  if (Exit.isSuccess(exit)) {
    yield* trackCreateCompletedEffect({
      input: exit.value.input,
      context: exit.value.context,
      durationMs,
    });
    return exit.value.result;
  }

  const error = Cause.squash(exit.cause);
  const input = yield* Ref.get(inputRef);
  const context = Option.getOrUndefined(yield* Ref.get(contextRef));
  if (error instanceof CreateCancellationError) {
    yield* trackCreateCancelledEffect({
      input,
      ...(context ? { context } : {}),
      durationMs,
      stage: error.stage,
    });
    return createCommandFailureResult(
      error.stage,
      error.message ?? "Operation cancelled.",
      context && context.operation !== "orm_init" ? createProjectResult(context) : undefined,
    );
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
  const { output } = resolveExecutionSettings(rawInput);
  if (!failure.errorReported) {
    yield* Effect.sync(() => cancel(`Create command failed: ${failure.message}`, { output }));
  }
  yield* trackCreateFailedEffect({
    input,
    ...(context ? { context } : {}),
    durationMs,
    error: failure.cause ?? failure,
    stage: failure.stage,
    reason: failure.reason,
    ...(failure.targetDirectoryKind ? { targetDirectoryKind: failure.targetDirectoryKind } : {}),
  });
  return createCommandFailureResult(
    failure.stage,
    failure.message,
    context && context.operation !== "orm_init" ? createProjectResult(context) : undefined,
  );
});

export function runCreateCommand(rawInput: CreateCommandInput = {}): Promise<CreateCommandResult> {
  return applicationRuntime.runPromise(runCreateCommandEffect(rawInput));
}

export type {
  CreateContext,
  CreatePromptContext,
  ExistingAppContext,
  CreateTargetPathState,
} from "./create-context";
