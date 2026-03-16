import type { CreateCommandInput, CreatePromptContext } from "../types";

import { trackCliTelemetry } from "./client";

export type CreateTelemetryFailureStage =
  | "validate_input"
  | "collect_context"
  | "scaffold_template"
  | "addons"
  | "prisma_setup"
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
    uses_defaults: input.yes === true,
    verbose: input.verbose === true,
    force: input.force === true,
    template: context?.template ?? input.template ?? null,
    database_provider: context?.prismaSetupContext.databaseProvider ?? input.provider ?? null,
    package_manager: context?.prismaSetupContext.packageManager ?? input.packageManager ?? null,
    schema_preset: context?.schemaPreset ?? input.schemaPreset ?? null,
    should_install: context?.prismaSetupContext.shouldInstall ?? input.install ?? null,
    should_generate: context?.prismaSetupContext.shouldGenerate ?? input.generate ?? null,
    uses_prisma_postgres:
      context?.prismaSetupContext.shouldUsePrismaPostgres ?? input.prismaPostgres ?? null,
    addons: resolvedAddons,
    addon_count: resolvedAddons.length,
    addon_scope: context?.addonSetupContext?.scope ?? null,
    skills_count: context?.addonSetupContext?.skills.length ?? null,
    skills_agents_count: context?.addonSetupContext?.skillsAgents.length ?? null,
    mcp_agents_count: context?.addonSetupContext?.mcpAgents.length ?? null,
    extension_target_count: context?.addonSetupContext?.extensionTargets.length ?? null,
    target_directory_state: context ? getTargetDirectoryState(context) : null,
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
  await trackCliTelemetry("create_completed", {
    ...getBaseCreateProperties(params.input, params.context),
    duration_ms: params.durationMs,
  });
}

export async function trackCreateFailed(params: {
  input: CreateCommandInput;
  context?: CreatePromptContext;
  durationMs: number;
  error?: unknown;
  stage: CreateTelemetryFailureStage;
}): Promise<void> {
  await trackCliTelemetry("create_failed", {
    ...getBaseCreateProperties(params.input, params.context),
    duration_ms: params.durationMs,
    failure_stage: params.stage,
    error_name: getErrorName(params.error),
    error_code: getErrorCode(params.error),
  });
}
