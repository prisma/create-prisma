import type { CreatePromptContext } from "../commands/create";
import {
  DEFAULT_PRISMA_NEXT_SPEC,
  PRISMA_NEXT_DEFAULT_VERSION,
  type ResolvedPrismaNextSpec,
} from "../constants/dependencies";
import type { CreateCommandInput } from "../types";

import { trackCliTelemetry } from "./client";

export type PrismaNextVersionKind = "default" | "npm-tag" | "npm-version" | "pkg-pr-new";

function classifyPrismaNextSpec(spec: ResolvedPrismaNextSpec | undefined): PrismaNextVersionKind {
  if (!spec || spec === DEFAULT_PRISMA_NEXT_SPEC) {
    return "default";
  }

  if (spec.kind === "pkg-pr-new") {
    return "pkg-pr-new";
  }

  if (spec.spec === PRISMA_NEXT_DEFAULT_VERSION) {
    return "default";
  }

  // npm dist-tags are sequences of lowercase letters / digits / hyphens that
  // don't start with a digit; semver releases always start with a digit. This
  // is intentionally a coarse classifier — npm itself accepts anything as a
  // tag, but tags collected over the wire are useful as a low-cardinality
  // signal for the onboarding audit.
  return /^[0-9]/.test(spec.spec) ? "npm-version" : "npm-tag";
}

function getPrismaNextVersionSpecString(spec: ResolvedPrismaNextSpec | undefined): string | null {
  if (!spec) {
    return null;
  }

  return spec.kind === "pkg-pr-new" ? `pkg-pr-new:${spec.ref}` : spec.spec;
}

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
  const resolvedPrismaNextSpec = context?.prismaSetupContext.prismaNextSpec;

  return {
    command: "create",
    "uses-defaults": input.yes === true,
    verbose: input.verbose === true,
    force: input.force === true,
    template: context?.template ?? input.template ?? null,
    "database-provider": context?.prismaSetupContext.databaseProvider ?? input.provider ?? null,
    "authoring-style": context?.prismaSetupContext.authoring ?? input.authoring ?? null,
    "package-manager": context?.prismaSetupContext.packageManager ?? input.packageManager ?? null,
    "should-install": context?.prismaSetupContext.shouldInstall ?? input.install ?? null,
    "should-emit": context?.prismaSetupContext.shouldEmit ?? input.emit ?? null,
    "uses-prisma-postgres":
      context?.prismaSetupContext.shouldUsePrismaPostgres ?? input.prismaPostgres ?? null,
    "target-directory-state": context ? getTargetDirectoryState(context) : null,
    "prisma-next-version-kind": classifyPrismaNextSpec(resolvedPrismaNextSpec),
    "prisma-next-version-spec":
      getPrismaNextVersionSpecString(resolvedPrismaNextSpec) ?? input.prismaNextVersion ?? null,
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
