import { Schema } from "effect";

import {
  CreateCancellationStageSchema,
  CreateFailureStageSchema,
  type CreateCancellationStage,
  type CreateFailureStage,
} from "./create-outcome";
import {
  AuthoringStyleSchema,
  CreateTemplateSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
} from "./types";

export const CREATE_PRISMA_RESULT_SCHEMA_VERSION = 1 as const;

export const PrismaWorkspaceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
});
export type PrismaWorkspace = typeof PrismaWorkspaceSchema.Type;

export const ComposerDeployResultSchema = Schema.Struct({
  appName: Schema.String,
  appUrl: Schema.optionalKey(Schema.String),
  serviceId: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(PrismaWorkspaceSchema),
  project: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    name: Schema.String,
    consoleUrl: Schema.optionalKey(Schema.String),
  }),
});
export type ComposerDeployResult = typeof ComposerDeployResultSchema.Type;

export const CreateNextStepSchema = Schema.Struct({
  command: Schema.String,
  description: Schema.String,
});
export type CreateNextStep = typeof CreateNextStepSchema.Type;

export const CreateProjectResultSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  template: CreateTemplateSchema,
  databaseProvider: DatabaseProviderSchema,
  authoring: AuthoringStyleSchema,
  packageManager: PackageManagerSchema,
});
export type CreateProjectResult = typeof CreateProjectResultSchema.Type;

export type CreateCommandFailureStage =
  | CreateFailureStage
  | CreateCancellationStage
  | "parse_arguments";

export const CreateCommandFailureStageSchema = Schema.Union([
  CreateFailureStageSchema,
  CreateCancellationStageSchema,
  Schema.Literal("parse_arguments"),
]);

export const CreateCommandSuccessResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(CREATE_PRISMA_RESULT_SCHEMA_VERSION),
  ok: Schema.Literal(true),
  project: CreateProjectResultSchema,
  deployment: Schema.NullOr(ComposerDeployResultSchema),
  nextSteps: Schema.Array(CreateNextStepSchema),
  warnings: Schema.Array(Schema.String),
});
export type CreateCommandSuccessResult = typeof CreateCommandSuccessResultSchema.Type;

export const CreateCommandFailureResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(CREATE_PRISMA_RESULT_SCHEMA_VERSION),
  ok: Schema.Literal(false),
  error: Schema.Struct({
    stage: CreateCommandFailureStageSchema,
    message: Schema.String,
  }),
  project: Schema.optionalKey(CreateProjectResultSchema),
});
export type CreateCommandFailureResult = typeof CreateCommandFailureResultSchema.Type;

export const CreateCommandResultSchema = Schema.Union([
  CreateCommandSuccessResultSchema,
  CreateCommandFailureResultSchema,
]);
export type CreateCommandResult = typeof CreateCommandResultSchema.Type;

export function createCommandFailureResult(
  stage: CreateCommandFailureStage,
  message: string,
  project?: CreateProjectResult,
): CreateCommandFailureResult {
  return {
    schemaVersion: CREATE_PRISMA_RESULT_SCHEMA_VERSION,
    ok: false,
    error: { stage, message },
    ...(project ? { project } : {}),
  };
}
