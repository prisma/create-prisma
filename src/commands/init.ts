import {
  cancel,
  intro,
  log,
  spinner,
} from "@clack/prompts";
import fs from "fs-extra";
import path from "node:path";

import { executePrismaSetupContext, collectPrismaSetupContext } from "../tasks/setup-prisma";
import { scaffoldInitTemplate } from "../templates/render-init-template";
import {
  PrismaSetupCommandInputSchema,
  type PrismaSetupCommandInput,
  type SchemaPreset,
} from "../types";
import { getCreatePrismaIntro } from "../ui/branding";

const DEFAULT_SCHEMA_PRESET: SchemaPreset = "basic";

async function readProjectPackageJson(projectDir: string): Promise<Record<string, unknown> | undefined> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return undefined;
  }

  return fs.readJson(packageJsonPath);
}

async function hasPackageJson(projectDir: string): Promise<boolean> {
  return fs.pathExists(path.join(projectDir, "package.json"));
}

async function hasPackageScript(
  projectDir: string,
  scriptName: string
): Promise<boolean> {
  const packageJson = await readProjectPackageJson(projectDir);
  if (!packageJson) {
    return false;
  }

  const scripts =
    typeof packageJson.scripts === "object" && packageJson.scripts !== null
      ? (packageJson.scripts as Record<string, unknown>)
      : {};

  return typeof scripts[scriptName] === "string" && scripts[scriptName].trim().length > 0;
}

async function warnIfWorkspaceRoot(projectDir: string): Promise<void> {
  const packageJson = await readProjectPackageJson(projectDir);
  if (!packageJson) {
    return;
  }

  if ("workspaces" in packageJson) {
    log.warn(
      "Detected a workspace root package.json. Prisma files will be initialized in the current directory."
    );
  }
}

export async function shouldInitCurrentProject(
  input: {
    name?: string;
    template?: string;
  },
  projectDir = process.cwd()
): Promise<boolean> {
  if (input.name || input.template) {
    return false;
  }

  return hasPackageJson(projectDir);
}

export async function runInitCommand(
  rawInput: PrismaSetupCommandInput = {},
  options: {
    showIntro?: boolean;
  } = {}
): Promise<void> {
  try {
    const input = PrismaSetupCommandInputSchema.parse(rawInput);
    const showIntro = options.showIntro ?? true;
    const projectDir = process.cwd();

    if (showIntro) {
      intro(getCreatePrismaIntro());
    }

    if (!(await hasPackageJson(projectDir))) {
      cancel(
        "No package.json found in the current directory. Run `create-prisma create` to scaffold a new project first."
      );
      return;
    }

    await warnIfWorkspaceRoot(projectDir);

    const prismaSetupContext = await collectPrismaSetupContext(input, {
      projectDir,
      defaultSchemaPreset: DEFAULT_SCHEMA_PRESET,
    });
    if (!prismaSetupContext) {
      return;
    }

    const initSpinner = spinner();
    initSpinner.start("Scaffolding Prisma files for the current project...");

    try {
      const renderResult = await scaffoldInitTemplate({
        projectDir,
        projectName: path.basename(projectDir),
        provider: prismaSetupContext.databaseProvider,
        schemaPreset: prismaSetupContext.schemaPreset,
        packageManager: prismaSetupContext.packageManager,
      });
      const fileAction =
        renderResult.writtenFiles.length > 0
          ? `Added ${renderResult.writtenFiles.length} Prisma file${
              renderResult.writtenFiles.length === 1 ? "" : "s"
            }.`
          : "Reused existing Prisma files.";
      initSpinner.stop(fileAction);

      if (renderResult.skippedFiles.length > 0) {
        log.warn(
          `Skipped ${renderResult.skippedFiles.length} existing Prisma file${
            renderResult.skippedFiles.length === 1 ? "" : "s"
          }.`
        );
      }
    } catch (error) {
      initSpinner.stop("Could not scaffold Prisma files.");
      cancel(error instanceof Error ? error.message : String(error));
      return;
    }

    await executePrismaSetupContext(prismaSetupContext, {
      projectDir,
      includeDevNextStep: await hasPackageScript(projectDir, "dev"),
    });
  } catch (error) {
    cancel(
      `Init command failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
