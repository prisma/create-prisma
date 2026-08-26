import { cancel, intro, isCancel, log, select, spinner, text } from "@clack/prompts";
import fs from "fs-extra";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  CREATE_PRISMA_RESULT_SCHEMA_VERSION,
  createCommandFailureResult,
  type CreateCommandResult,
  type CreateProjectResult,
} from "../result";
import {
  trackCreateCompleted,
  trackCreateFailed,
  type CreateTelemetryFailureStage,
} from "../telemetry";
import { scaffoldCreateFrameworkTemplate } from "../templates/render-create-template";
import { writeCreateTemplateDependencies } from "../tasks/install";
import type { PrismaSetupContext } from "../tasks/setup-prisma";
import { collectPrismaSetupContext, executePrismaSetupContext } from "../tasks/setup-prisma";
import {
  CreateCommandInputSchema,
  CreateTemplateSchema,
  type CreateCommandInput,
  type CreateTemplate,
} from "../types";
import { getCreatePrismaIntro } from "../ui/branding";
import { resolveExecutionSettings } from "../ui/output";
import { getErrorMessage } from "../utils/errors";
import { getUnsupportedNodeMessage, supportsPrismaNext } from "../utils/node-version";

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

type ExecuteCreateContextResult =
  | { ok: true; result: CreateCommandResult }
  | {
      ok: false;
      stage: CreateTelemetryFailureStage;
      error?: unknown;
      errorReported?: boolean;
    };

type CollectCreateContextResult =
  | { ok: true; context: CreatePromptContext }
  | { ok: false; message: string };

function toPackageName(projectName: string): string {
  return (
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "") || "app"
  );
}

function formatPathForDisplay(filePath: string): string {
  return path.relative(process.cwd(), filePath) || ".";
}

function validateProjectName(value: string | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length === 0) {
    return "Please enter a project name.";
  }

  if (trimmed === "..") {
    return "Project name cannot be '..'.";
  }

  if (path.isAbsolute(trimmed)) {
    return "Use a relative project name instead of an absolute path.";
  }

  return undefined;
}

function getProjectResult(context: CreatePromptContext): CreateProjectResult {
  return {
    name: context.projectPackageName,
    path: context.targetDirectory,
    template: context.template,
    databaseProvider: context.prismaSetupContext.databaseProvider,
    authoring: context.prismaSetupContext.authoring,
    packageManager: context.prismaSetupContext.packageManager,
  };
}

async function promptForProjectName(output: Writable): Promise<string | undefined> {
  const projectName = await text({
    message: "Project name",
    placeholder: DEFAULT_PROJECT_NAME,
    initialValue: DEFAULT_PROJECT_NAME,
    validate: validateProjectName,
    output,
  });

  if (isCancel(projectName)) {
    cancel("Operation cancelled.", { output });
    return undefined;
  }

  return String(projectName).trim();
}

async function promptForCreateTemplate(output: Writable): Promise<CreateTemplate | undefined> {
  const template = await select({
    message: "Select template",
    initialValue: DEFAULT_TEMPLATE,
    options: [
      {
        value: "minimal",
        label: "Minimal",
        hint: "Script-first Prisma 8 starter with no web framework",
      },
      {
        value: "hono",
        label: "Hono",
        hint: "Lightweight TypeScript API server",
      },
      {
        value: "elysia",
        label: "Elysia",
        hint: "Bun-friendly TypeScript API server",
      },
      {
        value: "nest",
        label: "NestJS",
        hint: "Structured Node API with controllers and services",
      },
      {
        value: "next",
        label: "Next.js",
        hint: "Full-stack React app with App Router",
      },
      {
        value: "svelte",
        label: "SvelteKit",
        hint: "Full-stack Svelte 5 app with Vite",
      },
      {
        value: "astro",
        label: "Astro",
        hint: "Content-oriented web app with server routes",
      },
      {
        value: "nuxt",
        label: "Nuxt",
        hint: "Full-stack Vue app with Nitro server routes",
      },
      {
        value: "tanstack-start",
        label: "TanStack Start",
        hint: "React app with file routes and server functions",
      },
    ],
    output,
  });

  if (isCancel(template)) {
    cancel("Operation cancelled.", { output });
    return undefined;
  }

  return CreateTemplateSchema.parse(template);
}

async function inspectTargetPath(targetPath: string): Promise<CreateTargetPathState> {
  if (!(await fs.pathExists(targetPath))) {
    return {
      exists: false,
      isDirectory: true,
      isEmptyDirectory: true,
    };
  }

  const stats = await fs.stat(targetPath);
  if (!stats.isDirectory()) {
    return {
      exists: true,
      isDirectory: false,
      isEmptyDirectory: false,
    };
  }

  const entries = await fs.readdir(targetPath);
  return {
    exists: true,
    isDirectory: true,
    isEmptyDirectory: entries.length === 0,
  };
}

export async function runCreateCommand(
  rawInput: CreateCommandInput = {},
): Promise<CreateCommandResult> {
  const startedAt = Date.now();
  let input: CreateCommandInput = {};
  let context: CreatePromptContext | undefined;
  let failureStage: CreateTelemetryFailureStage = "validate_input";
  const { output } = resolveExecutionSettings(rawInput);

  try {
    input = CreateCommandInputSchema.parse(rawInput);
    if (input.json && input.verbose) {
      throw new Error("--verbose cannot be used with --json because JSON mode is output-only.");
    }
    if (!supportsPrismaNext()) {
      const message = getUnsupportedNodeMessage();
      cancel(message, { output });
      process.exitCode = 1;
      return createCommandFailureResult(failureStage, message);
    }

    intro(getCreatePrismaIntro(), { output });

    failureStage = "collect_context";
    const collected = await collectCreateContext(input);
    if (!collected.ok) {
      process.exitCode = 1;
      const result = createCommandFailureResult(failureStage, collected.message);
      await trackCreateFailed({
        input,
        durationMs: Date.now() - startedAt,
        stage: failureStage,
      });
      return result;
    }
    context = collected.context;

    failureStage = "unknown";
    const executionResult = await executeCreateContext(context);
    if (!executionResult.ok) {
      process.exitCode = 1;
      const message = executionResult.error
        ? getErrorMessage(executionResult.error)
        : "Project setup did not complete.";
      if (executionResult.error && !executionResult.errorReported) {
        cancel(`Create command failed: ${message}`, { output });
      }

      await trackCreateFailed({
        input,
        context,
        durationMs: Date.now() - startedAt,
        error: executionResult.error,
        stage: executionResult.stage,
      });
      return createCommandFailureResult(executionResult.stage, message, getProjectResult(context));
    }

    await trackCreateCompleted({
      input,
      context,
      durationMs: Date.now() - startedAt,
    });
    return executionResult.result;
  } catch (error) {
    process.exitCode = 1;
    const message = getErrorMessage(error);
    cancel(`Create command failed: ${message}`, { output });
    await trackCreateFailed({
      input,
      context,
      durationMs: Date.now() - startedAt,
      error,
      stage: failureStage,
    });
    return createCommandFailureResult(
      failureStage,
      message,
      context ? getProjectResult(context) : undefined,
    );
  }
}

async function collectCreateContext(
  input: CreateCommandInput,
): Promise<CollectCreateContextResult> {
  const force = input.force === true;
  const { output, useDefaults } = resolveExecutionSettings(input);

  const projectNameInput =
    input.name ?? (useDefaults ? DEFAULT_PROJECT_NAME : await promptForProjectName(output));
  if (projectNameInput === undefined) {
    return { ok: false, message: "Operation cancelled." };
  }

  const projectName = String(projectNameInput).trim();
  const projectNameValidationError = validateProjectName(projectName);
  if (projectNameValidationError) {
    cancel(projectNameValidationError, { output });
    return { ok: false, message: projectNameValidationError };
  }

  const template =
    input.template ?? (useDefaults ? DEFAULT_TEMPLATE : await promptForCreateTemplate(output));
  if (!template) {
    return { ok: false, message: "Operation cancelled." };
  }

  const targetDirectory = path.resolve(process.cwd(), projectName);
  const targetPathState = await inspectTargetPath(targetDirectory);
  if (targetPathState.exists && !targetPathState.isDirectory) {
    const message = `Target path ${formatPathForDisplay(
      targetDirectory,
    )} already exists and is not a directory. Choose a different project name.`;
    cancel(message, { output });
    return { ok: false, message };
  }
  if (targetPathState.exists && !targetPathState.isEmptyDirectory && !force) {
    const message = `Target directory ${formatPathForDisplay(
      targetDirectory,
    )} is not empty. Use --force to continue.`;
    cancel(message, { output });
    return { ok: false, message };
  }

  const prismaSetupContext = await collectPrismaSetupContext(input, {
    projectDir: targetDirectory,
    template,
  });
  if (!prismaSetupContext) {
    return { ok: false, message: "Operation cancelled." };
  }

  return {
    ok: true,
    context: {
      targetDirectory,
      targetPathState,
      force,
      template,
      projectPackageName: toPackageName(path.basename(targetDirectory)),
      prismaSetupContext,
    },
  };
}

async function executeCreateContext(
  context: CreatePromptContext,
): Promise<ExecuteCreateContextResult> {
  const output = context.prismaSetupContext.output;
  const createSpinner = context.prismaSetupContext.verbose ? undefined : spinner({ output });
  createSpinner?.start("Creating Prisma 8 project...");

  try {
    if (context.prismaSetupContext.verbose) {
      log.step(`Scaffolding ${context.template} starter.`, { output });
    }

    await scaffoldCreateFrameworkTemplate({
      projectDir: context.targetDirectory,
      projectName: context.projectPackageName,
      template: context.template,
      provider: context.prismaSetupContext.databaseProvider,
      authoring: context.prismaSetupContext.authoring,
      packageManager: context.prismaSetupContext.packageManager,
    });

    if (context.prismaSetupContext.verbose) {
      log.success("Starter files scaffolded.", { output });
    }
  } catch (error) {
    createSpinner?.error("Could not create Prisma 8 project.");
    return {
      ok: false,
      stage: "scaffold_template",
      error,
    };
  }

  try {
    await writeCreateTemplateDependencies({
      template: context.template,
      packageManager: context.prismaSetupContext.packageManager,
      projectDir: context.targetDirectory,
    });
  } catch (error) {
    createSpinner?.error("Could not create Prisma 8 project.");
    return {
      ok: false,
      stage: "scaffold_template",
      error,
    };
  }

  const forceWarning =
    context.targetPathState.exists && !context.targetPathState.isEmptyDirectory && context.force
      ? `Used --force in non-empty directory ${formatPathForDisplay(context.targetDirectory)}.`
      : undefined;
  if (forceWarning) log.warn(forceWarning, { output });

  const nextSteps =
    formatPathForDisplay(context.targetDirectory) === "."
      ? []
      : [
          {
            command: `cd ${formatPathForDisplay(context.targetDirectory)}`,
            description: "Enter your new project directory.",
          },
        ];

  try {
    const setupResult = await executePrismaSetupContext(context.prismaSetupContext, {
      prependNextSteps: nextSteps,
      projectDir: context.targetDirectory,
      projectName: context.projectPackageName,
      template: context.template,
      createdProjectPath: context.targetDirectory,
      includeDevNextStep: true,
      initializeGit: !context.targetPathState.exists || context.targetPathState.isEmptyDirectory,
      progressSpinner: createSpinner,
    });

    if (!setupResult.ok) {
      return {
        ok: false,
        stage: "prisma_setup",
        error: setupResult.error,
        errorReported: setupResult.errorReported,
      };
    }

    const warnings = [...setupResult.warnings];
    if (forceWarning) warnings.unshift(forceWarning);

    return {
      ok: true,
      result: {
        schemaVersion: CREATE_PRISMA_RESULT_SCHEMA_VERSION,
        ok: true,
        project: getProjectResult(context),
        deployment: setupResult.deployment,
        nextSteps: setupResult.nextSteps,
        warnings,
      },
    };
  } catch (error) {
    createSpinner?.error("Could not create Prisma 8 project.");
    return {
      ok: false,
      stage: "prisma_setup",
      error,
    };
  }
}
