import { cancel, intro, isCancel, log, select, spinner, text } from "@clack/prompts";
import { Cause, Clock, Effect, Exit, FileSystem, Option, Ref, Schema } from "effect";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  CreateCancellationError,
  CreateFailure,
  type CreateFailureReason,
  type CreateFailureStage,
} from "../create-outcome";
import {
  CREATE_PRISMA_RESULT_SCHEMA_VERSION,
  createCommandFailureResult,
  type CreateCommandResult,
  type CreateNextStep,
  type CreateProjectResult,
} from "../result";
import { applicationRuntime } from "../runtime";
import {
  trackCreateCancelledEffect,
  trackCreateCompletedEffect,
  trackCreateFailedEffect,
} from "../telemetry/create";
import { scaffoldCreateFrameworkTemplateEffect } from "../templates/render-create-template";
import { writeCreateTemplateDependenciesEffect } from "../tasks/install";
import {
  collectPrismaSetupContextEffect,
  executePrismaSetupContextEffect,
  type PrismaSetupContext,
} from "../tasks/setup-prisma";
import {
  CreateTemplateSchema,
  decodeCreateCommandInput,
  type CreateCommandInput,
  type CreateTemplate,
} from "../types";
import { getCreatePrismaIntro } from "../ui/branding";
import { resolveExecutionSettings } from "../ui/output";
import { getErrorMessage } from "../utils/errors";
import { getUnsupportedNodeMessage, supportsPrisma } from "../utils/node-version";

const DEFAULT_PROJECT_NAME = "my-app";
const DEFAULT_TEMPLATE: CreateTemplate = "minimal";

export type CreateTargetPathState = {
  exists: boolean;
  isDirectory: boolean;
  isEmptyDirectory: boolean;
};

export type CreatePromptContext = {
  targetDirectory: string;
  targetPathState: CreateTargetPathState;
  force: boolean;
  template: CreateTemplate;
  projectPackageName: string;
  prismaSetupContext: PrismaSetupContext;
};

const toPackageName = (projectName: string) =>
  projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "") || "app";

const formatPathForDisplay = (filePath: string) => path.relative(process.cwd(), filePath) || ".";

function validateProjectName(value: string | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length === 0) return "Please enter a project name.";
  if (trimmed === "..") return "Project name cannot be '..'.";
  if (path.isAbsolute(trimmed)) return "Use a relative project name instead of an absolute path.";
}

const projectResult = (context: CreatePromptContext): CreateProjectResult => ({
  name: context.projectPackageName,
  path: context.targetDirectory,
  template: context.template,
  databaseProvider: context.prismaSetupContext.databaseProvider,
  authoring: context.prismaSetupContext.authoring,
  packageManager: context.prismaSetupContext.packageManager,
});

const promptForProjectName = Effect.fn("Prompts.projectName")(function* (output: Writable) {
  const value = yield* Effect.tryPromise(() =>
    text({
      message: "Project name",
      placeholder: DEFAULT_PROJECT_NAME,
      initialValue: DEFAULT_PROJECT_NAME,
      validate: validateProjectName,
      output,
    }),
  );
  if (isCancel(value)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output }));
    return yield* new CreateCancellationError({ stage: "project_name" });
  }
  return String(value).trim();
});

const promptForCreateTemplate = Effect.fn("Prompts.template")(function* (output: Writable) {
  const value = yield* Effect.tryPromise(() =>
    select({
      message: "Select template",
      initialValue: DEFAULT_TEMPLATE,
      options: [
        {
          value: "minimal",
          label: "Minimal",
          hint: "Script-first Prisma 8 starter with no web framework",
        },
        { value: "hono", label: "Hono", hint: "Lightweight TypeScript API server" },
        { value: "elysia", label: "Elysia", hint: "Bun-friendly TypeScript API server" },
        {
          value: "nest",
          label: "NestJS",
          hint: "Structured Node API with controllers and services",
        },
        { value: "next", label: "Next.js", hint: "Full-stack React app with App Router" },
        { value: "svelte", label: "SvelteKit", hint: "Full-stack Svelte 5 app with Vite" },
        { value: "astro", label: "Astro", hint: "Content-oriented web app with server routes" },
        { value: "nuxt", label: "Nuxt", hint: "Full-stack Vue app with Nitro server routes" },
        {
          value: "tanstack-start",
          label: "TanStack Start",
          hint: "React app with file routes and server functions",
        },
      ],
      output,
    }),
  );
  if (isCancel(value)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output }));
    return yield* new CreateCancellationError({ stage: "template" });
  }
  return yield* Schema.decodeUnknownEffect(CreateTemplateSchema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new CreateFailure({
          stage: "collect_context",
          reason: "invalid_input",
          message: cause.message,
          cause,
        }),
    ),
  );
});

const inspectTargetPath = Effect.fn("Create.inspectTargetPath")(function* (targetPath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(targetPath))) {
    return { exists: false, isDirectory: true, isEmptyDirectory: true };
  }
  const stats = yield* fs.stat(targetPath);
  if (stats.type !== "Directory") {
    return { exists: true, isDirectory: false, isEmptyDirectory: false };
  }
  return {
    exists: true,
    isDirectory: true,
    isEmptyDirectory: (yield* fs.readDirectory(targetPath)).length === 0,
  };
});

const collectCreateContext = Effect.fn("Create.collectContext")(function* (
  input: CreateCommandInput,
) {
  const force = input.force === true;
  const { output, useDefaults } = resolveExecutionSettings(input);
  const projectName = String(
    input.name ?? (useDefaults ? DEFAULT_PROJECT_NAME : yield* promptForProjectName(output)),
  ).trim();
  const validationError = validateProjectName(projectName);
  if (validationError) {
    yield* Effect.sync(() => cancel(validationError, { output }));
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "invalid_project_name",
      message: validationError,
      errorReported: true,
    });
  }

  const template =
    input.template ?? (useDefaults ? DEFAULT_TEMPLATE : yield* promptForCreateTemplate(output));
  const targetDirectory = path.resolve(process.cwd(), projectName);
  const targetPathState = yield* inspectTargetPath(targetDirectory);
  if (targetPathState.exists && !targetPathState.isDirectory) {
    const message = `Target path ${formatPathForDisplay(targetDirectory)} already exists and is not a directory. Choose a different project name.`;
    yield* Effect.sync(() => cancel(message, { output }));
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "target_path_not_directory",
      message,
      errorReported: true,
    });
  }
  if (targetPathState.exists && !targetPathState.isEmptyDirectory && !force) {
    const message = `Target directory ${formatPathForDisplay(targetDirectory)} is not empty. Use --force to continue.`;
    yield* Effect.sync(() => cancel(message, { output }));
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "target_directory_not_empty",
      message,
      errorReported: true,
    });
  }

  const prismaSetupContext = yield* collectPrismaSetupContextEffect(input, {
    projectDir: targetDirectory,
    template,
  });
  return {
    targetDirectory,
    targetPathState,
    force,
    template,
    projectPackageName: toPackageName(path.basename(targetDirectory)),
    prismaSetupContext,
  } satisfies CreatePromptContext;
});

const atStage = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  stage: CreateFailureStage,
  reason: CreateFailureReason,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof CreateFailure || error instanceof CreateCancellationError
        ? error
        : new CreateFailure({ stage, reason, message: getErrorMessage(error), cause: error }),
    ),
  );

const executeCreateContext = Effect.fn("Create.execute")(function* (context: CreatePromptContext) {
  const output = context.prismaSetupContext.output;
  const createSpinner = context.prismaSetupContext.verbose ? undefined : spinner({ output });
  yield* Effect.sync(() => {
    createSpinner?.start("Creating Prisma 8 project...");
    if (context.prismaSetupContext.verbose)
      log.step(`Scaffolding ${context.template} starter.`, { output });
  });

  yield* atStage(
    scaffoldCreateFrameworkTemplateEffect({
      projectDir: context.targetDirectory,
      projectName: context.projectPackageName,
      template: context.template,
      provider: context.prismaSetupContext.databaseProvider,
      authoring: context.prismaSetupContext.authoring,
      packageManager: context.prismaSetupContext.packageManager,
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
          if (context.prismaSetupContext.verbose)
            log.success("Starter files scaffolded.", { output });
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
    initializeGit: !context.targetPathState.exists || context.targetPathState.isEmptyDirectory,
    progressSpinner: createSpinner,
  });
  const warnings = [...setup.warnings];
  if (forceWarning) warnings.unshift(forceWarning);
  return {
    schemaVersion: CREATE_PRISMA_RESULT_SCHEMA_VERSION,
    ok: true,
    project: projectResult(context),
    deployment: setup.deployment,
    nextSteps: setup.nextSteps,
    warnings,
  } satisfies CreateCommandResult;
});

const createProjectEffect = Effect.fn("Create.project")(function* (
  rawInput: CreateCommandInput,
  inputRef: Ref.Ref<CreateCommandInput>,
  contextRef: Ref.Ref<Option.Option<CreatePromptContext>>,
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
  const context = yield* atStage(
    collectCreateContext(input),
    "collect_context",
    "unexpected_error",
  );
  yield* Ref.set(contextRef, Option.some(context));
  return { input, context, result: yield* executeCreateContext(context) };
});

export const runCreateCommandEffect = Effect.fn("Create.run")(function* (
  rawInput: CreateCommandInput = {},
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const inputRef = yield* Ref.make<CreateCommandInput>(rawInput);
  const contextRef = yield* Ref.make<Option.Option<CreatePromptContext>>(Option.none());
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
      context ? projectResult(context) : undefined,
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
  });
  return createCommandFailureResult(
    failure.stage,
    failure.message,
    context ? projectResult(context) : undefined,
  );
});

export function runCreateCommand(rawInput: CreateCommandInput = {}): Promise<CreateCommandResult> {
  return applicationRuntime.runPromise(runCreateCommandEffect(rawInput));
}
