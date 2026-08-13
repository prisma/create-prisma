import type { CreatePromptContext } from "../commands/create";
import type { CreateCommandInput } from "../types";

import { trackCliTelemetry } from "./client";

export const CREATE_PRISMA_NEXT_COMPLETED_EVENT = "cli:create_prisma_next_command_completed";
export const CREATE_PRISMA_NEXT_FAILED_EVENT = "cli:create_prisma_next_command_failed";

export type CreateTelemetryFailureStage =
  | "validate_input"
  | "collect_context"
  | "scaffold_template"
  | "prisma_setup"
  | "unknown";

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
  return {
    command: "create",
    "uses-defaults": input.yes === true,
    verbose: input.verbose === true,
    force: input.force === true,
    template: context?.template ?? input.template ?? null,
    "database-provider": context?.prismaSetupContext.databaseProvider ?? input.provider ?? null,
    "authoring-style": context?.prismaSetupContext.authoring ?? input.authoring ?? null,
    "package-manager": context?.prismaSetupContext.packageManager ?? input.packageManager ?? null,
    "should-deploy": context?.prismaSetupContext.shouldDeploy ?? input.deploy ?? null,
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
  await trackCliTelemetry(CREATE_PRISMA_NEXT_COMPLETED_EVENT, {
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
  await trackCliTelemetry(CREATE_PRISMA_NEXT_FAILED_EVENT, {
    ...getBaseCreateProperties(params.input, params.context),
    "duration-ms": params.durationMs,
    "failure-stage": params.stage,
    "error-name": getErrorName(params.error),
    "error-code": getErrorCode(params.error),
  });
}
