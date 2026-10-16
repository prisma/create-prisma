import { Effect } from "effect";

import type { CreateContext } from "../commands/create";
import type { CreateCommandInput } from "../types";

import { TELEMETRY_TIMEOUT_MS, trackCliTelemetryEffect } from "./client";

export const CREATE_PRISMA_TELEMETRY_COMMAND = "create-prisma";

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

function getDatabaseTarget(input: CreateCommandInput, context?: CreateContext): string | null {
  const setup = context?.operation === "orm_init" ? undefined : context?.prismaSetupContext;
  return setup?.databaseProvider ?? input.provider ?? null;
}

export const trackCreateEffect = (params: {
  input: CreateCommandInput;
  context?: CreateContext;
  exitCode: number;
}) =>
  trackCliTelemetryEffect({
    command: CREATE_PRISMA_TELEMETRY_COMMAND,
    flags: getCreateFlags(params.input),
    databaseTarget: getDatabaseTarget(params.input, params.context),
    exitCode: params.exitCode,
  }).pipe(
    Effect.timeout(TELEMETRY_TIMEOUT_MS),
    Effect.catch(() => Effect.void),
  );
