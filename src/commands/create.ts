import {
  cancel,
  intro,
  isCancel,
  log,
  select,
  spinner,
  text,
} from "@clack/prompts";
import fs from "fs-extra";
import path from "node:path";

import {
  scaffoldCreateTemplate,
} from "../templates/render-create-template";
import {
  CreateCommandInputSchema,
  CreateTemplateSchema,
  type CreatePromptContext,
  type CreateTargetPathState,
  type CreateCommandInput,
  type CreateTemplate,
  type InitCommandInput,
  type SchemaPreset,
} from "../types";
import {
  collectInitContext,
  executeInitContext,
} from "./init";
import { getCreatePrismaIntro } from "../ui/branding";

const DEFAULT_PROJECT_NAME = "my-app";
const DEFAULT_TEMPLATE: CreateTemplate = "hono";
const DEFAULT_SCHEMA_PRESET: SchemaPreset = "basic";

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

  if (trimmed === "." || trimmed === "..") {
    return "Project name cannot be '.' or '..'.";
  }

  if (path.isAbsolute(trimmed)) {
    return "Use a relative project name instead of an absolute path.";
  }

  return undefined;
}

async function promptForProjectName(): Promise<string | undefined> {
  const projectName = await text({
    message: "Project name",
    placeholder: DEFAULT_PROJECT_NAME,
    initialValue: DEFAULT_PROJECT_NAME,
    validate: validateProjectName,
  });

  if (isCancel(projectName)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return String(projectName).trim();
}

async function promptForCreateTemplate(): Promise<CreateTemplate | undefined> {
  const template = await select({
    message: "Select template",
    initialValue: DEFAULT_TEMPLATE,
    options: [
      {
        value: "hono",
        label: "Hono",
        hint: "Bun + TypeScript API starter",
      },
      {
        value: "next",
        label: "Next.js",
        hint: "App Router + TypeScript starter",
      },
    ],
  });

  if (isCancel(template)) {
    cancel("Operation cancelled.");
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

export async function runCreateCommand(rawInput: CreateCommandInput = {}): Promise<void> {
  try {
    const input = CreateCommandInputSchema.parse(rawInput);

    intro(getCreatePrismaIntro());

    const context = await collectCreateContext(input);
    if (!context) {
      return;
    }

    await executeCreateContext(context);
  } catch (error) {
    cancel(
      `Create command failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function collectCreateContext(
  input: CreateCommandInput
): Promise<CreatePromptContext | undefined> {
  const useDefaults = input.yes === true;
  const force = input.force === true;

  const projectName =
    input.name ?? (useDefaults ? DEFAULT_PROJECT_NAME : await promptForProjectName());
  if (!projectName) {
    return;
  }

  const template =
    input.template ??
    (useDefaults ? DEFAULT_TEMPLATE : await promptForCreateTemplate());
  if (!template) {
    return;
  }

  const schemaPreset =
    input.schemaPreset ?? DEFAULT_SCHEMA_PRESET;

  const targetDirectory = path.resolve(process.cwd(), projectName);
  const targetPathState = await inspectTargetPath(targetDirectory);
  if (targetPathState.exists && !targetPathState.isDirectory) {
    cancel(
      `Target path ${formatPathForDisplay(
        targetDirectory
      )} already exists and is not a directory. Choose a different project name.`
    );
    return;
  }
  if (
    targetPathState.exists &&
    !targetPathState.isEmptyDirectory &&
    !force
  ) {
    cancel(
      `Target directory ${formatPathForDisplay(
        targetDirectory
      )} is not empty. Use --force to continue.`
    );
    return;
  }

  const initInput: InitCommandInput = {
    yes: input.yes,
    verbose: input.verbose,
    provider: input.provider,
    packageManager: input.packageManager,
    prismaPostgres: input.prismaPostgres,
    databaseUrl: input.databaseUrl,
    install: input.install,
    generate: input.generate,
    schemaPreset,
  };

  const initContext = await collectInitContext(initInput, {
    skipIntro: true,
    projectDir: targetDirectory,
  });
  if (!initContext) {
    return;
  }

  return {
    targetDirectory,
    targetPathState,
    force,
    template,
    schemaPreset,
    projectPackageName: toPackageName(path.basename(targetDirectory)),
    initContext,
  };
}

async function executeCreateContext(context: CreatePromptContext): Promise<void> {
  const scaffoldSpinner = spinner();
  scaffoldSpinner.start(`Scaffolding ${context.template} project...`);
  try {
    await scaffoldCreateTemplate({
      projectDir: context.targetDirectory,
      projectName: context.projectPackageName,
      template: context.template,
      schemaPreset: context.schemaPreset,
      packageManager: context.initContext.packageManager,
    });
    scaffoldSpinner.stop("Project files scaffolded.");
  } catch (error) {
    scaffoldSpinner.stop("Could not scaffold project files.");
    cancel(error instanceof Error ? error.message : String(error));
    return;
  }

  if (
    context.targetPathState.exists &&
    !context.targetPathState.isEmptyDirectory &&
    context.force
  ) {
    log.warn(
      `Used --force in non-empty directory ${formatPathForDisplay(context.targetDirectory)}.`
    );
  }

  const cdStep = `- cd ${formatPathForDisplay(context.targetDirectory)}`;
  await executeInitContext(context.initContext, {
    skipIntro: true,
    prependNextSteps: [cdStep],
    projectDir: context.targetDirectory,
    includeDevNextStep: true,
  });
}
