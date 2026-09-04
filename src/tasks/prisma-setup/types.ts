import type { spinner } from "@clack/prompts";
import type { Writable } from "node:stream";

import type { ComposerDeployResult, CreateNextStep } from "../../result";
import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "../../types";
import type { GitInitializationResult } from "../initialize-git";

export type PrismaSetupRunOptions = {
  prependNextSteps?: CreateNextStep[];
  projectDir?: string;
  projectName?: string;
  template?: CreateTemplate;
  createdProjectPath?: string;
  includeDevNextStep?: boolean;
  initializeGit?: boolean;
  progressSpinner?: ReturnType<typeof spinner>;
};

export type PrismaSetupContext = {
  projectDir: string;
  verbose: boolean;
  json: boolean;
  output: Writable;
  databaseProvider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager: PackageManager;
  shouldDeploy: boolean;
  shouldPromptForWorkspace: boolean;
  workspace?: string;
};

export type PrismaSetupSuccess = {
  deployment: ComposerDeployResult | null;
  nextSteps: CreateNextStep[];
  gitInitialization?: GitInitializationResult;
  warnings: string[];
};
