import { Effect } from "effect";

import type { CreatePromptContext } from "../commands/create";
import type {
  CreateCancellationStage,
  CreateFailureReason,
  CreateFailureStage,
} from "../create-outcome";
import type { CreateCommandInput } from "../types";
import { applicationRuntime } from "../runtime";

import { trackCliTelemetryEffect } from "./client";

export const CREATE_PRISMA_NEXT_COMPLETED_EVENT = "cli:create_prisma_next_command_completed";
export const CREATE_PRISMA_NEXT_FAILED_EVENT = "cli:create_prisma_next_command_failed";
export const CREATE_PRISMA_NEXT_CANCELLED_EVENT = "cli:create_prisma_next_command_cancelled";

export type CreateTelemetryFailureStage = CreateFailureStage;

const expectedRejectionReasons = new Set<CreateFailureReason>([
  "invalid_input",
  "unsupported_node_version",
  "invalid_project_name",
  "target_path_not_directory",
  "target_directory_not_empty",
  "unsupported_configuration",
  "not_authenticated",
  "workspace_missing",
  "workspace_mismatch",
  "project_name_collision",
]);

function getFailureClass(reason: CreateFailureReason): "expected_rejection" | "technical_failure" {
  return expectedRejectionReasons.has(reason) ? "expected_rejection" : "technical_failure";
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
  return {
    "telemetry-schema-version": 2,
    command: "create",
    "uses-defaults": input.yes === true || input.json === true,
    json: input.json === true,
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

function getPrismaCliFailureProperty(
  error: unknown,
  property: "prismaCliCommand" | "prismaCliErrorCode",
): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const value = Reflect.get(error, property);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const trackCreateCompletedEffect = Effect.fn("Telemetry.createCompleted")(
  function* (params: {
    input: CreateCommandInput;
    context: CreatePromptContext;
    durationMs: number;
  }) {
    yield* trackCliTelemetryEffect(CREATE_PRISMA_NEXT_COMPLETED_EVENT, {
      ...getBaseCreateProperties(params.input, params.context),
      "duration-ms": params.durationMs,
    }).pipe(
      Effect.scoped,
      Effect.catch(() => Effect.void),
    );
  },
);

export const trackCreateFailedEffect = Effect.fn("Telemetry.createFailed")(function* (params: {
  input: CreateCommandInput;
  context?: CreatePromptContext;
  durationMs: number;
  error?: unknown;
  stage: CreateTelemetryFailureStage;
  reason: CreateFailureReason;
}) {
  yield* trackCliTelemetryEffect(CREATE_PRISMA_NEXT_FAILED_EVENT, {
    ...getBaseCreateProperties(params.input, params.context),
    "duration-ms": params.durationMs,
    "failure-class": getFailureClass(params.reason),
    "failure-stage": params.stage,
    "failure-reason": params.reason,
    "error-name": getErrorName(params.error),
    "error-code": getErrorCode(params.error),
    "prisma-cli-command": getPrismaCliFailureProperty(params.error, "prismaCliCommand"),
    "prisma-cli-error-code": getPrismaCliFailureProperty(params.error, "prismaCliErrorCode"),
  }).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.void),
  );
});

export const trackCreateCancelledEffect = Effect.fn("Telemetry.createCancelled")(
  function* (params: {
    input: CreateCommandInput;
    context?: CreatePromptContext;
    durationMs: number;
    stage: CreateCancellationStage;
  }) {
    yield* trackCliTelemetryEffect(CREATE_PRISMA_NEXT_CANCELLED_EVENT, {
      ...getBaseCreateProperties(params.input, params.context),
      "duration-ms": params.durationMs,
      "cancellation-stage": params.stage,
    }).pipe(
      Effect.scoped,
      Effect.catch(() => Effect.void),
    );
  },
);

export const trackCreateCompleted = (params: Parameters<typeof trackCreateCompletedEffect>[0]) =>
  applicationRuntime.runPromise(trackCreateCompletedEffect(params));
export const trackCreateFailed = (params: Parameters<typeof trackCreateFailedEffect>[0]) =>
  applicationRuntime.runPromise(trackCreateFailedEffect(params));
export const trackCreateCancelled = (params: Parameters<typeof trackCreateCancelledEffect>[0]) =>
  applicationRuntime.runPromise(trackCreateCancelledEffect(params));
