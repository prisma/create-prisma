import { cancel, intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import fs from "fs-extra";
import path from "node:path";

import { scaffoldCreateTemplate } from "../templates/render-create-template";
import { addPackageDependency, writeCreateTemplateDependencies } from "../tasks/install";
import type { CreateAddonSetupContext } from "../tasks/setup-addons";
import type { PrismaSetupContext } from "../tasks/setup-prisma";
import {
  CreateCommandInputSchema,
  CreateTemplateSchema,
  isComposerDeployableTemplate,
  type CreateCommandInput,
  type CreateTemplate,
  type SchemaPreset,
} from "../types";
import {
  collectPrismaSetupInitialContext,
  completePrismaSetupContext,
  executePrismaMigrationAndSeed,
  executePrismaSetupContext,
} from "../tasks/setup-prisma";
import {
  collectCreateAddonSetupContext,
  executeCreateAddonSetupContext,
} from "../tasks/setup-addons";
import {
  collectComposerDeployContext,
  executeComposerDeployContext,
  getComposerDeployScriptMap,
  resolveComposerPostgresDatabaseUrl,
  type ComposerDeployContext,
  type ComposerDeployResult,
} from "../tasks/deploy-with-composer";
import {
  trackCreateCompleted,
  trackCreateFailed,
  type CreateTelemetryFailureStage,
} from "../telemetry";
import { getCreatePrismaIntro } from "../ui/branding";
import { getRunScriptCommand } from "../utils/package-manager";

const DEFAULT_PROJECT_NAME = "my-app";
const DEFAULT_TEMPLATE: CreateTemplate = "hono";
const DEFAULT_SCHEMA_PRESET: SchemaPreset = "basic";

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
  addonSetupContext?: CreateAddonSetupContext;
  composerContext?: ComposerDeployContext;
  composerDeployContext?: ComposerDeployContext;
  useComposerPostgres: boolean;
};

type ExecuteCreateContextResult =
  | { ok: true }
  | {
      ok: false;
      stage: CreateTelemetryFailureStage;
      error?: unknown;
    };

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
        hint: "TypeScript API starter",
      },
      {
        value: "elysia",
        label: "Elysia",
        hint: "TypeScript API starter with Elysia's Node adapter",
      },
      {
        value: "nest",
        label: "NestJS",
        hint: "Official Nest-style API starter with a Prisma service",
      },
      {
        value: "next",
        label: "Next.js",
        hint: "App Router + TypeScript starter",
      },
      {
        value: "svelte",
        label: "SvelteKit",
        hint: "Official minimal SvelteKit + TypeScript starter",
      },
      {
        value: "astro",
        label: "Astro",
        hint: "Official minimal Astro starter with API route example",
      },
      {
        value: "nuxt",
        label: "Nuxt",
        hint: "Official minimal Nuxt starter with Nitro API route example",
      },
      {
        value: "tanstack-start",
        label: "TanStack Start",
        hint: "TanStack Start React app with file routes and server functions",
      },
      {
        value: "turborepo",
        label: "Turborepo",
        hint: "Monorepo starter with apps + packages/db Prisma package",
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
  const startedAt = Date.now();
  let input: CreateCommandInput = {};
  let context: CreatePromptContext | undefined;
  let failureStage: CreateTelemetryFailureStage = "validate_input";

  try {
    input = CreateCommandInputSchema.parse(rawInput);

    intro(getCreatePrismaIntro());

    failureStage = "collect_context";
    context = await collectCreateContext(input);
    if (!context) {
      return;
    }

    failureStage = "unknown";
    const executionResult = await executeCreateContext(context);
    if (!executionResult.ok) {
      failureStage = executionResult.stage;
      const error =
        executionResult.error instanceof Error
          ? executionResult.error
          : new Error(
              executionResult.error === undefined
                ? `Create command failed during ${executionResult.stage}`
                : String(executionResult.error),
            );
      throw error;
    }

    await trackCreateCompleted({
      input,
      context,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const commandError = error instanceof Error ? error : new Error(String(error));
    cancel(`Create command failed: ${commandError.message}`);
    try {
      await trackCreateFailed({
        input,
        context,
        durationMs: Date.now() - startedAt,
        error: commandError,
        stage: failureStage,
      });
    } catch {
      // Telemetry is best-effort and must not hide the original command error.
    }
    throw commandError;
  }
}

async function collectCreateContext(
  input: CreateCommandInput,
): Promise<CreatePromptContext | undefined> {
  const useDefaults = input.yes === true;
  const force = input.force === true;

  const projectNameInput =
    input.name ?? (useDefaults ? DEFAULT_PROJECT_NAME : await promptForProjectName());
  if (projectNameInput === undefined) {
    return;
  }

  const projectName = String(projectNameInput).trim();
  const projectNameValidationError = validateProjectName(projectName);
  if (projectNameValidationError) {
    cancel(projectNameValidationError);
    return;
  }

  const template =
    input.template ?? (useDefaults ? DEFAULT_TEMPLATE : await promptForCreateTemplate());
  if (!template) {
    return;
  }

  const targetDirectory = path.resolve(process.cwd(), projectName);
  const targetPathState = await inspectTargetPath(targetDirectory);
  if (targetPathState.exists && !targetPathState.isDirectory) {
    cancel(
      `Target path ${formatPathForDisplay(
        targetDirectory,
      )} already exists and is not a directory. Choose a different project name.`,
    );
    return;
  }
  if (targetPathState.exists && !targetPathState.isEmptyDirectory && !force) {
    cancel(
      `Target directory ${formatPathForDisplay(
        targetDirectory,
      )} is not empty. Use --force to continue.`,
    );
    return;
  }

  const prismaSetupInitialContext = await collectPrismaSetupInitialContext(input, {
    projectDir: targetDirectory,
    defaultSchemaPreset: DEFAULT_SCHEMA_PRESET,
  });
  if (!prismaSetupInitialContext) {
    return;
  }

  const projectPackageName = toPackageName(path.basename(targetDirectory));
  const composerDeployContext = await collectComposerDeployContext(input, {
    template,
    packageManager: prismaSetupInitialContext.packageManager,
    projectName: projectPackageName,
    useDefaults,
  });
  if (composerDeployContext === undefined) {
    return;
  }

  const prismaSetupContext = await completePrismaSetupContext(input, prismaSetupInitialContext);
  if (!prismaSetupContext) {
    return;
  }

  const useComposerPostgres = Boolean(
    composerDeployContext && prismaSetupContext.shouldUsePrismaPostgres,
  );
  if (composerDeployContext) {
    composerDeployContext.useComposerPostgres = useComposerPostgres;
  }

  if (useComposerPostgres) {
    log.info(
      "Prisma Postgres selected: Composer will provision the database and wire it into the application.",
    );
  }

  const composerEnabled =
    isComposerDeployableTemplate(template) && prismaSetupContext.packageManager !== "deno";
  const composerContext = composerEnabled
    ? (composerDeployContext ?? {
        template,
        packageManager: prismaSetupContext.packageManager,
        projectName: projectPackageName,
        useComposerPostgres: false,
      })
    : undefined;

  const addonSetupContext = await collectCreateAddonSetupContext(input, {
    useDefaults,
    provider: prismaSetupContext.databaseProvider,
    shouldUsePrismaPostgres: prismaSetupContext.shouldUsePrismaPostgres,
    shouldUseComposerDeploy: Boolean(composerDeployContext),
  });
  if (addonSetupContext === undefined) {
    return;
  }

  return {
    targetDirectory,
    targetPathState,
    force,
    template,
    projectPackageName,
    prismaSetupContext,
    addonSetupContext: addonSetupContext ?? undefined,
    composerContext,
    composerDeployContext: composerDeployContext ?? undefined,
    useComposerPostgres,
  };
}

async function executeCreateContext(
  context: CreatePromptContext,
): Promise<ExecuteCreateContextResult> {
  const scaffoldSpinner = spinner();
  scaffoldSpinner.start(`Scaffolding ${context.template} project...`);
  try {
    await scaffoldCreateTemplate({
      projectDir: context.targetDirectory,
      projectName: context.projectPackageName,
      template: context.template,
      schemaPreset: context.prismaSetupContext.schemaPreset,
      provider: context.prismaSetupContext.databaseProvider,
      packageManager: context.prismaSetupContext.packageManager,
      composer: Boolean(context.composerContext),
      composerPostgres: context.useComposerPostgres,
    });
    scaffoldSpinner.stop("Project files scaffolded.");
  } catch (error) {
    scaffoldSpinner.stop("Could not scaffold project files.");
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
      composer: Boolean(context.composerContext),
      projectDir: context.targetDirectory,
    });
    if (context.composerContext) {
      await addPackageDependency({
        scripts: getComposerDeployScriptMap(context.composerContext),
        scriptMode: "if-missing",
        projectDir: context.targetDirectory,
      });
    }
  } catch (error) {
    return {
      ok: false,
      stage: "scaffold_template",
      error,
    };
  }

  if (
    context.targetPathState.exists &&
    !context.targetPathState.isEmptyDirectory &&
    context.force
  ) {
    log.warn(
      `Used --force in non-empty directory ${formatPathForDisplay(context.targetDirectory)}.`,
    );
  }

  const nextSteps =
    formatPathForDisplay(context.targetDirectory) === "."
      ? []
      : [`- cd ${formatPathForDisplay(context.targetDirectory)}`];
  if (context.addonSetupContext) {
    try {
      await executeCreateAddonSetupContext({
        context: context.addonSetupContext,
        packageManager: context.prismaSetupContext.packageManager,
        projectDir: context.targetDirectory,
        verbose: context.prismaSetupContext.verbose,
      });
    } catch (error) {
      return {
        ok: false,
        stage: "addons",
        error,
      };
    }
  }

  let prismaResult: Awaited<ReturnType<typeof executePrismaSetupContext>>;
  try {
    const initialPrismaContext = context.useComposerPostgres
      ? {
          ...context.prismaSetupContext,
          shouldUsePrismaPostgres: false,
          shouldMigrateAndSeed: false,
        }
      : context.prismaSetupContext;
    prismaResult = await executePrismaSetupContext(initialPrismaContext, {
      prependNextSteps: nextSteps,
      projectDir: context.targetDirectory,
      includeDevNextStep: true,
      includeMigrationAndSeedNextSteps: !context.useComposerPostgres,
    });

    if (!prismaResult.ok) {
      return {
        ok: false,
        stage: "prisma_setup",
      };
    }
  } catch (error) {
    return {
      ok: false,
      stage: "prisma_setup",
      error,
    };
  }

  let deployResult: ComposerDeployResult | undefined;
  if (context.composerDeployContext) {
    try {
      const result = await executeComposerDeployContext({
        context: context.composerDeployContext,
        projectDir: context.targetDirectory,
      });
      if (!result.ok && !result.cancelled) {
        return {
          ok: false,
          stage: "composer_deploy",
          error: result.error,
        };
      }
      if (result.ok) {
        deployResult = result.result;
        if (context.useComposerPostgres) {
          const databaseUrl = await resolveComposerPostgresDatabaseUrl({
            context: context.composerDeployContext,
            projectDir: context.targetDirectory,
          });
          const migration = await executePrismaMigrationAndSeed({
            context: context.prismaSetupContext,
            projectDir: context.targetDirectory,
            databaseUrl,
          });
          if (migration.warning) {
            prismaResult.warningSection += `\n\n- ${migration.warning}`;
          }
          if (!migration.didMigrate) {
            prismaResult.nextSteps.push(
              `- ${getRunScriptCommand(context.prismaSetupContext.packageManager, "db:migrate")}`,
            );
          }
          if (!migration.didSeed) {
            prismaResult.nextSteps.push(
              `- ${getRunScriptCommand(context.prismaSetupContext.packageManager, "db:seed")}`,
            );
          }
        }
        prismaResult.nextSteps.push(
          `- ${getRunScriptCommand(context.prismaSetupContext.packageManager, "deploy")}`,
        );
      }
    } catch (error) {
      return {
        ok: false,
        stage: "composer_deploy",
        error,
      };
    }
  }

  const summaryLines: string[] = [];
  summaryLines.push(`Setup complete.${prismaResult.warningSection}`);
  if (deployResult) {
    summaryLines.push(
      "",
      "Deployed with Prisma Composer:",
      `- App: ${deployResult.appName}`,
      ...deployResult.services.map(
        (service) =>
          `- Service: ${service.address} (${service.id})${service.url ? `\n  ${service.url}` : ""}`,
      ),
    );
  }
  summaryLines.push("", "Next steps:", prismaResult.nextSteps.join("\n"));
  outro(summaryLines.join("\n"));

  return { ok: true };
}
