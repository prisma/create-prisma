import path from "node:path";

import type { ComposerDeployResult, CreateNextStep } from "../../result";
import { getRunScriptCommand } from "../../utils/package-manager";
import type { PrismaSetupContext, PrismaSetupRunOptions } from "./types";

export const formatNextSteps = (steps: CreateNextStep[]) =>
  steps.map((step) => `${step.command}\n  ${step.description}`).join("\n\n");

const formatPlatformTarget = (name: string | null, id: string) => (name ? `${name} (${id})` : id);

export function formatProjectSummary(options: {
  createdProjectPath?: string;
  deployment?: ComposerDeployResult;
}): string {
  const lines: string[] = [];
  if (options.createdProjectPath) lines.push(`Path: ${path.resolve(options.createdProjectPath)}`);
  if (options.deployment?.workspace) {
    lines.push(
      `Workspace: ${formatPlatformTarget(options.deployment.workspace.name, options.deployment.workspace.id)}`,
    );
  }
  if (options.deployment) {
    lines.push(
      `Project: ${
        options.deployment.project.id
          ? formatPlatformTarget(options.deployment.project.name, options.deployment.project.id)
          : options.deployment.project.name
      }`,
    );
    lines.push(`App: ${options.deployment.appUrl ?? options.deployment.appName}`);
    if (options.deployment.project.consoleUrl) {
      lines.push(`Console: ${options.deployment.project.consoleUrl}`);
    }
  }
  return lines.join("\n");
}

export function showsComposerDevStep(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions,
): boolean {
  return options.includeDevNextStep === true && context.packageManager !== "deno";
}

export function buildNextSteps(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions,
): CreateNextStep[] {
  const nextSteps = [...(options.prependNextSteps ?? [])];
  if (context.databaseProvider === "mongo") {
    nextSteps.push({
      command: "Set MONGODB_URL in your environment",
      description: "Composer uses this secret when deploying the MongoDB template.",
    });
  }
  if (showsComposerDevStep(context, options)) {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "dev:composer"),
      description: "Build and start the app with Prisma Composer locally.",
    });
  } else if (options.includeDevNextStep) {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "dev"),
      description: "Start the Deno app after setting DATABASE_URL in .env.",
    });
  }
  if (context.packageManager !== "deno") {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "deploy"),
      description: "Build and deploy the app with Prisma Composer.",
    });
  }
  return nextSteps;
}
