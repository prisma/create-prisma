import { Effect } from "effect";

import type { CreateContext } from "../commands/create";
import {
  isStructuredErrorCode,
  PrismaCliCommandError,
  type CreateCancellationStage,
  type CreateFailureReason,
  type CreateFailureStage,
  type CreateTargetDirectoryKind,
} from "../create-outcome";
import type { CreateCommandInput } from "../types";
import { applicationRuntime } from "../runtime";
import { CommandExecutionError } from "../services/command-runner";
import { getPackageManagerErrorCode } from "../utils/package-manager-error-code";

import { TELEMETRY_TIMEOUT_MS, trackCliTelemetryEffect, type TelemetryProperties } from "./client";

// Every run reports under one command; `operation` and `outcome` tell runs apart.
export const CREATE_PRISMA_TELEMETRY_COMMAND = "create-prisma";

// A failed or cancelled run exits 1 (src/index.ts).
const exitCodes = { completed: 0, failed: 1, cancelled: 1 } as const;

// Positional and `--name` values never leave the machine, so `name` reports no flag.
const flagNames = {
  template: "template",
  provider: "provider",
  authoring: "authoring",
  packageManager: "package-manager",
  deploy: "deploy",
  workspace: "workspace",
  skills: "skills",
  force: "force",
  yes: "yes",
  verbose: "verbose",
  json: "json",
} as const satisfies Partial<Record<keyof CreateCommandInput, string>>;

function getCreateFlags(input: CreateCommandInput): string[] {
  return Object.entries(flagNames).flatMap(([key, flag]) =>
    input[key as keyof typeof flagNames] === undefined ? [] : [flag],
  );
}

export type CreateTelemetryFailureStage = CreateFailureStage;

const expectedRejectionReasons = new Set<CreateFailureReason>([
  "invalid_input",
  "unsupported_node_version",
  "unsupported_package_manager_version",
  "package_manager_not_found",
  "invalid_project_name",
  "target_path_not_directory",
  "target_directory_not_empty",
  "target_has_migrations",
  "unsupported_configuration",
  "not_authenticated",
  "workspace_missing",
  "workspace_mismatch",
  "project_name_collision",
]);

function getFailureClass(reason: CreateFailureReason): "expected_rejection" | "technical_failure" {
  return expectedRejectionReasons.has(reason) ? "expected_rejection" : "technical_failure";
}

function getTargetDirectoryState(context: CreateContext): string {
  if (!context.targetPathState.exists) {
    return "new";
  }

  if (context.targetPathState.isEmptyDirectory) {
    return "empty_directory";
  }

  return "non_empty_directory";
}

function getDatabaseTarget(input: CreateCommandInput, context?: CreateContext): string | null {
  const setup = context?.operation === "orm_init" ? undefined : context?.prismaSetupContext;
  return setup?.databaseProvider ?? input.provider ?? null;
}

function getBaseCreateProperties(
  input: CreateCommandInput,
  context?: CreateContext,
): TelemetryProperties {
  const setup = context?.operation === "orm_init" ? undefined : context?.prismaSetupContext;
  const initializing = context?.operation === "orm_init";
  return {
    "telemetry-schema-version": 3,
    operation: initializing ? "orm_init" : "create",
    "uses-defaults": input.yes === true || input.json === true,
    json: input.json === true,
    verbose: input.verbose === true,
    force: input.force === true,
    template: initializing ? null : (context?.template ?? input.template ?? null),
    "authoring-style": setup?.authoring ?? input.authoring ?? null,
    "package-manager": initializing
      ? context.packageManager
      : (setup?.packageManager ?? input.packageManager ?? null),
    "agent-skills": initializing ? null : setup ? [...setup.skillAgents] : (input.skills ?? null),
    "should-deploy": initializing ? false : (setup?.shouldDeploy ?? input.deploy ?? null),
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

function getChildProcessFailureProperty(error: unknown): string | null {
  return error instanceof CommandExecutionError || error instanceof PrismaCliCommandError
    ? (error.childProcessFailure ?? null)
    : null;
}

// Our own install, or the one `prisma orm init` runs inside an existing app.
function getPackageManagerErrorCodeProperty(
  error: unknown,
  stage: CreateTelemetryFailureStage,
): string | null {
  if (stage === "install_dependencies" && error instanceof CommandExecutionError) {
    return getPackageManagerErrorCode(error.command, error) ?? null;
  }
  return error instanceof PrismaCliCommandError ? (error.packageManagerErrorCode ?? null) : null;
}

function getPrismaCliFailureProperty(
  error: unknown,
  property: "prismaCliCommand" | "prismaCliErrorCode" | "prismaCliCauseCode",
): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const value = Reflect.get(error, property);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getPrismaCliCauseCodeProperty(error: unknown): string | null {
  const causeCode = getPrismaCliFailureProperty(error, "prismaCliCauseCode");
  return isStructuredErrorCode(causeCode) ? causeCode : null;
}

const trackCreateOutcomeEffect = (
  outcome: keyof typeof exitCodes,
  input: CreateCommandInput,
  context: CreateContext | undefined,
  properties: TelemetryProperties,
) =>
  trackCliTelemetryEffect({
    command: CREATE_PRISMA_TELEMETRY_COMMAND,
    flags: getCreateFlags(input),
    databaseTarget: getDatabaseTarget(input, context),
    exitCode: exitCodes[outcome],
    properties: { ...getBaseCreateProperties(input, context), outcome, ...properties },
  }).pipe(
    Effect.timeout(TELEMETRY_TIMEOUT_MS),
    Effect.catch(() => Effect.void),
  );

export const trackCreateCompletedEffect = Effect.fn("Telemetry.createCompleted")(
  function* (params: { input: CreateCommandInput; context: CreateContext; durationMs: number }) {
    yield* trackCreateOutcomeEffect("completed", params.input, params.context, {
      "duration-ms": params.durationMs,
    });
  },
);

export const trackCreateFailedEffect = Effect.fn("Telemetry.createFailed")(function* (params: {
  input: CreateCommandInput;
  context?: CreateContext;
  durationMs: number;
  error?: unknown;
  stage: CreateTelemetryFailureStage;
  reason: CreateFailureReason;
  targetDirectoryKind?: CreateTargetDirectoryKind;
}) {
  yield* trackCreateOutcomeEffect("failed", params.input, params.context, {
    "duration-ms": params.durationMs,
    "failure-class": getFailureClass(params.reason),
    "failure-stage": params.stage,
    "failure-reason": params.reason,
    "target-directory-kind": params.targetDirectoryKind ?? null,
    "error-name": getErrorName(params.error),
    "error-code": getErrorCode(params.error),
    "child-process-failure": getChildProcessFailureProperty(params.error),
    "prisma-cli-command": getPrismaCliFailureProperty(params.error, "prismaCliCommand"),
    "prisma-cli-error-code": getPrismaCliFailureProperty(params.error, "prismaCliErrorCode"),
    "prisma-cli-cause-code": getPrismaCliCauseCodeProperty(params.error),
    "package-manager-error-code": getPackageManagerErrorCodeProperty(params.error, params.stage),
  });
});

export const trackCreateCancelledEffect = Effect.fn("Telemetry.createCancelled")(
  function* (params: {
    input: CreateCommandInput;
    context?: CreateContext;
    durationMs: number;
    stage: CreateCancellationStage;
  }) {
    yield* trackCreateOutcomeEffect("cancelled", params.input, params.context, {
      "duration-ms": params.durationMs,
      "cancellation-stage": params.stage,
    });
  },
);

export const trackCreateCompleted = (params: Parameters<typeof trackCreateCompletedEffect>[0]) =>
  applicationRuntime.runPromise(trackCreateCompletedEffect(params));
export const trackCreateFailed = (params: Parameters<typeof trackCreateFailedEffect>[0]) =>
  applicationRuntime.runPromise(trackCreateFailedEffect(params));
export const trackCreateCancelled = (params: Parameters<typeof trackCreateCancelledEffect>[0]) =>
  applicationRuntime.runPromise(trackCreateCancelledEffect(params));
