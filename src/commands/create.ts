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

import { scaffoldCreateTemplate } from "../templates/render-create-template";
import {
  CreateCommandInputSchema,
  CreateTemplateSchema,
  SchemaPresetSchema,
  type CreateCommandInput,
  type CreateTemplate,
  type InitCommandInput,
  type SchemaPreset,
} from "../types";
import { runInitCommand } from "./init";

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

async function promptForProjectName(): Promise<string | undefined> {
  const projectName = await text({
    message: "Project name",
    placeholder: DEFAULT_PROJECT_NAME,
    initialValue: DEFAULT_PROJECT_NAME,
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      return trimmed.length > 0
        ? undefined
        : "Please enter a valid project name.";
    },
  });

  if (isCancel(projectName)) {
    cancel("Cancelled.");
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
    ],
  });

  if (isCancel(template)) {
    cancel("Cancelled.");
    return undefined;
  }

  return CreateTemplateSchema.parse(template);
}

async function promptForSchemaPreset(
  defaultSchemaPreset: SchemaPreset
): Promise<SchemaPreset | undefined> {
  const schemaPreset = await select({
    message: "Choose schema preset",
    initialValue: defaultSchemaPreset,
    options: [
      {
        value: "basic",
        label: "Basic",
        hint: "Adds a User model and sample /users route",
      },
      {
        value: "empty",
        label: "Empty",
        hint: "Datasource only",
      },
    ],
  });

  if (isCancel(schemaPreset)) {
    cancel("Cancelled.");
    return undefined;
  }

  return SchemaPresetSchema.parse(schemaPreset);
}

async function isDirectoryEmpty(directoryPath: string): Promise<boolean> {
  if (!(await fs.pathExists(directoryPath))) {
    return true;
  }

  const entries = await fs.readdir(directoryPath);
  return entries.length === 0;
}

export async function runCreateCommand(rawInput: CreateCommandInput = {}): Promise<void> {
  const input = CreateCommandInputSchema.parse(rawInput);
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
    input.schemaPreset ??
    (useDefaults
      ? DEFAULT_SCHEMA_PRESET
      : await promptForSchemaPreset(DEFAULT_SCHEMA_PRESET));
  if (!schemaPreset) {
    return;
  }

  const targetDirectory = path.resolve(process.cwd(), projectName);
  const targetExists = await fs.pathExists(targetDirectory);
  const targetIsEmpty = await isDirectoryEmpty(targetDirectory);
  if (targetExists && !targetIsEmpty && !force) {
    cancel(
      `Target directory ${formatPathForDisplay(
        targetDirectory
      )} is not empty. Use --force to continue.`
    );
    return;
  }

  intro("Create Prisma");

  const scaffoldSpinner = spinner();
  scaffoldSpinner.start(`Scaffolding ${template} project...`);
  try {
    await scaffoldCreateTemplate({
      projectDir: targetDirectory,
      projectName: toPackageName(path.basename(targetDirectory)),
      template,
      schemaPreset,
    });
    scaffoldSpinner.stop("Project files scaffolded.");
  } catch (error) {
    scaffoldSpinner.stop("Could not scaffold project files.");
    cancel(error instanceof Error ? error.message : String(error));
    return;
  }

  if (targetExists && !targetIsEmpty && force) {
    log.warn(
      `Used --force in non-empty directory ${formatPathForDisplay(targetDirectory)}.`
    );
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

  const previousDirectory = process.cwd();
  process.chdir(targetDirectory);
  try {
    await runInitCommand(initInput, {
      skipIntro: true,
    });
  } finally {
    process.chdir(previousDirectory);
  }

  const didWritePrismaSchema = await fs.pathExists(
    path.join(targetDirectory, "prisma/schema.prisma")
  );
  if (!didWritePrismaSchema) {
    return;
  }

  log.info(`Project ready in ${formatPathForDisplay(targetDirectory)}.`);
  log.info(`Run: cd ${formatPathForDisplay(targetDirectory)}`);
}
