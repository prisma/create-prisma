import type { spinner } from "@clack/prompts";
import type { Writable } from "node:stream";

import type { ComposerDeployResult, CreateNextStep } from "../../result";
import type {
  AgentSkillTarget,
  AuthoringStyle,
  CreateTemplate,
  DatabaseProvider,
  PackageManager,
} from "../../types";
import type { GitInitializationResult } from "../initialize-git";

export type PrismaSetupRunOptions = {
  prependNextSteps?: CreateNextStep[];
  projectDir?: string;
  projectName?: string;
  template?: CreateTemplate;
  createdProjectPath?: string;
  includeDevNextStep?: boolean;
  initializeGit?: boolean;
  force?: boolean;
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
  /** Agents whose skill files the project gets; empty means none, no postinstall hook, no sync script. */
  skillAgents: readonly AgentSkillTarget[];
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
