import type { CreateFailureStage } from "./create-outcome";
import type { ComposerDeployResult } from "./tasks/deploy-with-composer";
import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "./types";

export const CREATE_PRISMA_RESULT_SCHEMA_VERSION = 1 as const;

export type CreateNextStep = {
  command: string;
  description: string;
};

export type CreateProjectResult = {
  name: string;
  path: string;
  template: CreateTemplate;
  databaseProvider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager: PackageManager;
};

export type CreateCommandFailureStage = CreateFailureStage | "parse_arguments";

export type CreateCommandSuccessResult = {
  schemaVersion: typeof CREATE_PRISMA_RESULT_SCHEMA_VERSION;
  ok: true;
  project: CreateProjectResult;
  deployment: ComposerDeployResult | null;
  nextSteps: CreateNextStep[];
  warnings: string[];
};

export type CreateCommandFailureResult = {
  schemaVersion: typeof CREATE_PRISMA_RESULT_SCHEMA_VERSION;
  ok: false;
  error: {
    stage: CreateCommandFailureStage;
    message: string;
  };
  project?: CreateProjectResult;
};

export type CreateCommandResult = CreateCommandSuccessResult | CreateCommandFailureResult;

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
