import type { CreatePromptContext } from "../commands/create";
import type { CreateCommandInput } from "../types";

import { trackCliTelemetry } from "./client";

export type CreateTelemetryFailureStage =
  | "validate_input"
  | "collect_context"
  | "scaffold_template"
  | "addons"
  | "prisma_setup"
  | "compute_deploy"
  | "unknown";

function getRequestedAddons(input: CreateCommandInput): string[] {
  const addons: string[] = [];

  if (input.skills === true) {
    addons.push("skills");
  }
  if (input.mcp === true) {
    addons.push("mcp");
  }
  if (input.extension === true) {
    addons.push("extension");
  }

  return addons;
}

function getTargetDirectoryState(context: CreatePromptContext): string {
  if (!context.targetPathState.exists) {
    return "new";
  }

  if (context.targetPathState.isEmptyDirectory) {
    return "empty_directory";
  }

  return "non_empty_directory";
}

function getBaseCreateProperties(
  input: CreateCommandInput,
  context?: CreatePromptContext,
): Record<string, boolean | number | string | string[] | null> {
  const resolvedAddons = context?.addonSetupContext?.addons ?? getRequestedAddons(input);

  return {
    command: "create",
    "uses-defaults": input.yes === true,
    verbose: input.verbose === true,
    force: input.force === true,
    template: context?.template ?? input.template ?? null,
    "database-provider": context?.prismaSetupContext.databaseProvider ?? input.provider ?? null,
    "package-manager": context?.prismaSetupContext.packageManager ?? input.packageManager ?? null,
    "schema-preset": context?.prismaSetupContext.schemaPreset ?? input.schemaPreset ?? null,
    "should-install": context?.prismaSetupContext.shouldInstall ?? input.install ?? null,
    "should-generate": context?.prismaSetupContext.shouldGenerate ?? input.generate ?? null,
    "uses-prisma-postgres":
      context?.prismaSetupContext.shouldUsePrismaPostgres ?? input.prismaPostgres ?? null,
    addons: resolvedAddons,
    "addon-count": resolvedAddons.length,
    "addon-scope": context?.addonSetupContext?.scope ?? null,
    "skills-count": context?.addonSetupContext?.skills.length ?? null,
    "skills-agents-count": context?.addonSetupContext?.skillsAgents.length ?? null,
    "mcp-agents-count": context?.addonSetupContext?.mcpAgents.length ?? null,
    "extension-target-count": context?.addonSetupContext?.extensionTargets.length ?? null,
    "target-directory-state": context ? getTargetDirectoryState(context) : null,
  };
}

function getErrorName(error: unknown): string | null {
  if (error instanceof Error) {
    return error.name;
  }

  return error === undefined ? null : "UnknownError";
}

function getErrorCode(error: unknown): number | string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const exitCode = Reflect.get(error, "exitCode");
  if (typeof exitCode === "number") {
    return exitCode;
  }

  const code = Reflect.get(error, "code");
  return typeof code === "number" || typeof code === "string" ? code : null;
}

export async function trackCreateCompleted(params: {
  input: CreateCommandInput;
  context: CreatePromptContext;
  durationMs: number;
}): Promise<void> {
  await trackCliTelemetry("cli:create_command_completed", {
    ...getBaseCreateProperties(params.input, params.context),
    "duration-ms": params.durationMs,
  });
}

export async function trackCreateFailed(params: {
  input: CreateCommandInput;
  context?: CreatePromptContext;
  durationMs: number;
  error?: unknown;
  stage: CreateTelemetryFailureStage;
}): Promise<void> {
  await trackCliTelemetry("cli:create_command_failed", {
    ...getBaseCreateProperties(params.input, params.context),
    "duration-ms": params.durationMs,
    "failure-stage": params.stage,
    "error-name": getErrorName(params.error),
    "error-code": getErrorCode(params.error),
  });
}
