import { cancel, confirm, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import fs from "fs-extra";
import path from "node:path";
import type { Writable } from "node:stream";

import { PRISMA_DENO_CLI_PACKAGE, PRISMA_PLATFORM_CLI_PACKAGE } from "../constants/dependencies";
import {
  ClassifiedCreateError,
  CreateCancellationError,
  getCreateFailureReason,
  type CreateFailureReason,
  type CreateFailureStage,
} from "../create-outcome";
import type { CreateNextStep } from "../result";
import { scaffoldCreateSharedTemplates } from "../templates/render-create-template";
import {
  AuthoringStyleSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
  packageManagers,
  type AuthoringStyle,
  type CreateTemplate,
  type DatabaseProvider,
  type PackageManager,
  type PrismaSetupCommandInput,
} from "../types";
import { resolveExecutionSettings } from "../ui/output";
import { getErrorMessage } from "../utils/errors";
import {
  detectPackageManager,
  getInstallCommand,
  getPackageExecutionArgs,
  getRunScriptCommand,
} from "../utils/package-manager";
import { runSetupCommand } from "../utils/run-command";
import { deployNewProjectWithComposer, type ComposerDeployResult } from "./deploy-with-composer";
import { initializeGitRepository, type GitInitializationResult } from "./initialize-git";
import { installProjectDependencies, writePrismaDependencies } from "./install";

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgres";
const DEFAULT_AUTHORING: AuthoringStyle = "psl";

type PrismaSetupRunOptions = {
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

export type PrismaSetupExecutionResult =
  | {
      ok: true;
      deployment: ComposerDeployResult | null;
      nextSteps: CreateNextStep[];
      gitInitialization?: GitInitializationResult;
      warnings: string[];
    }
  | {
      ok: false;
      cancelled: true;
      stage: "select_workspace";
      errorReported?: boolean;
    }
  | {
      ok: false;
      cancelled?: false;
      stage: CreateFailureStage;
      reason: CreateFailureReason;
      error?: unknown;
      errorReported?: boolean;
    };

async function promptForDatabaseProvider(output: Writable): Promise<DatabaseProvider> {
  const databaseProvider = await select({
    message: "Select your database",
    initialValue: DEFAULT_DATABASE_PROVIDER,
    options: [
      { value: "postgres", label: "PostgreSQL", hint: "Prisma Postgres with Composer" },
      { value: "mongo", label: "MongoDB", hint: "Connect an existing MongoDB database" },
    ],
    output,
  });
  if (isCancel(databaseProvider)) {
    cancel("Operation cancelled.", { output });
    throw new CreateCancellationError("database_provider");
  }
  return DatabaseProviderSchema.parse(databaseProvider);
}

async function promptForAuthoringStyle(output: Writable): Promise<AuthoringStyle> {
  const authoring = await select({
    message: "Choose contract authoring style",
    initialValue: DEFAULT_AUTHORING,
    options: [
      { value: "psl", label: "PSL", hint: "Prisma schema syntax" },
      { value: "typescript", label: "TypeScript", hint: "TypeScript contract builder" },
    ],
    output,
  });
  if (isCancel(authoring)) {
    cancel("Operation cancelled.", { output });
    throw new CreateCancellationError("authoring_style");
  }
  return AuthoringStyleSchema.parse(authoring);
}

function getPackageManagerHint(option: PackageManager, detected: PackageManager) {
  const hints = {
    npm: "Node.js default",
    pnpm: "Fast, disk-efficient package manager",
    yarn: "Yarn package manager",
    bun: "Fast runtime and package manager",
    deno: "Deno runtime (minimal PostgreSQL apps)",
  } satisfies Record<PackageManager, string>;
  return option === detected ? `Detected; ${hints[option]}` : hints[option];
}

async function promptForPackageManager(
  detected: PackageManager,
  output: Writable,
): Promise<PackageManager> {
  const packageManager = await select({
    message: "Choose package manager",
    initialValue: detected,
    options: packageManagers.map((value) => ({
      value,
      label: value,
      hint: getPackageManagerHint(value, detected),
    })),
    output,
  });
  if (isCancel(packageManager)) {
    cancel("Operation cancelled.", { output });
    throw new CreateCancellationError("package_manager");
  }
  return PackageManagerSchema.parse(packageManager);
}

async function promptForDeployment(output: Writable): Promise<boolean> {
  const shouldDeploy = await confirm({
    message: "Deploy to Prisma now?",
    initialValue: true,
    output,
  });
  if (isCancel(shouldDeploy)) {
    cancel("Operation cancelled.", { output });
    throw new CreateCancellationError("deployment_intent");
  }
  return Boolean(shouldDeploy);
}

export async function collectPrismaSetupContext(
  input: PrismaSetupCommandInput,
  options: { projectDir?: string; template?: CreateTemplate } = {},
): Promise<PrismaSetupContext> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const { json, output, useDefaults } = resolveExecutionSettings(input);

  const databaseProvider =
    input.provider ??
    (useDefaults ? DEFAULT_DATABASE_PROVIDER : await promptForDatabaseProvider(output));
  const authoring =
    input.authoring ?? (useDefaults ? DEFAULT_AUTHORING : await promptForAuthoringStyle(output));
  const detectedPackageManager = await detectPackageManager(projectDir);
  const packageManager =
    input.packageManager ??
    (useDefaults
      ? detectedPackageManager
      : await promptForPackageManager(detectedPackageManager, output));
  if (packageManager === "deno" && databaseProvider !== "postgres") {
    throw new ClassifiedCreateError(
      "unsupported_configuration",
      "Deno support currently requires PostgreSQL.",
    );
  }
  if (packageManager === "deno" && options.template && options.template !== "minimal") {
    throw new ClassifiedCreateError(
      "unsupported_configuration",
      "Deno support currently requires the minimal template.",
    );
  }
  if (packageManager === "deno" && input.deploy === true) {
    throw new ClassifiedCreateError(
      "unsupported_configuration",
      "Prisma Compute does not support Deno deployments yet. Use --no-deploy.",
    );
  }

  const shouldDeploy =
    packageManager === "deno"
      ? false
      : (input.deploy ?? (json ? true : useDefaults ? false : await promptForDeployment(output)));
  return {
    projectDir,
    verbose: input.verbose === true,
    json,
    output,
    databaseProvider,
    authoring,
    packageManager,
    shouldDeploy,
    shouldPromptForWorkspace: !useDefaults,
    ...(input.workspace ? { workspace: input.workspace } : {}),
  };
}

function getContractPath(authoring: AuthoringStyle) {
  return `src/prisma/contract${authoring === "typescript" ? ".ts" : ".prisma"}`;
}

function getInitTarget(provider: DatabaseProvider): "postgres" | "mongodb" {
  return provider === "mongo" ? "mongodb" : "postgres";
}

function getPrismaCliInvocation(packageManager: PackageManager, args: string[]) {
  const packageName =
    packageManager === "deno" ? PRISMA_DENO_CLI_PACKAGE : PRISMA_PLATFORM_CLI_PACKAGE;
  return getPackageExecutionArgs(packageManager, [packageName, ...args]);
}

async function runPrismaInit(context: PrismaSetupContext, projectDir: string): Promise<void> {
  const args = [
    "orm",
    "init",
    "--yes",
    "--no-interactive",
    "--target",
    getInitTarget(context.databaseProvider),
    "--authoring",
    context.authoring,
    "--schema-path",
    getContractPath(context.authoring),
    "--skip-install",
  ];
  const invocation = getPrismaCliInvocation(context.packageManager, args);
  if (context.verbose) {
    log.step(`Running ${[invocation.command, ...invocation.args].join(" ")}`, {
      output: context.output,
    });
  }
  await runSetupCommand({
    command: invocation.command,
    args: invocation.args,
    cwd: projectDir,
    env: { ...process.env, CI: "1" },
    verbose: context.verbose,
    json: context.json,
  });
  if (context.packageManager === "deno") await fs.remove(path.join(projectDir, "prisma-next.md"));
}

async function initializeAgentSkills(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<void> {
  if (context.packageManager === "deno") return;

  const invocation = getPrismaCliInvocation(context.packageManager, [
    "init",
    "--yes",
    "--no-interactive",
  ]);
  if (context.verbose) {
    log.step(`Running ${[invocation.command, ...invocation.args].join(" ")}`, {
      output: context.output,
    });
  }
  await runSetupCommand({
    command: invocation.command,
    args: invocation.args,
    cwd: projectDir,
    env: { ...process.env, CI: "1" },
    verbose: context.verbose,
    json: context.json,
  });
}

async function ensureGitignoreEntry(projectDir: string, entry: string): Promise<void> {
  const gitignorePath = path.join(projectDir, ".gitignore");
  const existing = (await fs.pathExists(gitignorePath))
    ? await fs.readFile(gitignorePath, "utf8")
    : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignorePath, `${existing}${separator}${entry}\n`, "utf8");
}

async function ensureMongoEnvironment(projectDir: string): Promise<void> {
  const envPath = path.join(projectDir, ".env");
  if (!(await fs.pathExists(envPath))) {
    await fs.writeFile(
      envPath,
      'DATABASE_URL="mongodb://localhost:27017/mydb?replicaSet=rs0&directConnection=true"\n',
      "utf8",
    );
  }
  await ensureGitignoreEntry(projectDir, ".env");
}

async function ensureComposerTypeScriptOptions(projectDir: string): Promise<void> {
  const tsconfigPath = path.join(projectDir, "tsconfig.json");
  const tsconfig = await fs.readFile(tsconfigPath, "utf8");
  const additions: string[] = [];
  if (!/"allowImportingTsExtensions"\s*:/.test(tsconfig)) {
    additions.push('    "allowImportingTsExtensions": true,');
  }
  if (!/"noEmit"\s*:/.test(tsconfig)) {
    additions.push('    "noEmit": true,');
  }
  if (additions.length === 0) return;

  const updated = tsconfig.replace(
    /"compilerOptions"\s*:\s*\{/,
    (match) => `${match}\n${additions.join("\n")}`,
  );
  if (updated === tsconfig) {
    throw new Error("tsconfig.json is missing compilerOptions.");
  }
  await fs.writeFile(tsconfigPath, updated, "utf8");
}

async function runPrismaCli(
  context: PrismaSetupContext,
  projectDir: string,
  args: string[],
): Promise<void> {
  const invocation = getPrismaCliInvocation(context.packageManager, args);
  if (context.verbose) {
    log.step([invocation.command, ...invocation.args].join(" "), { output: context.output });
  }
  await runSetupCommand({
    command: invocation.command,
    args: invocation.args,
    cwd: projectDir,
    env: { ...process.env, CI: "1" },
    verbose: context.verbose,
    json: context.json,
  });
}

async function emitContract(context: PrismaSetupContext, projectDir: string): Promise<void> {
  await runPrismaCli(context, projectDir, ["contract", "emit"]);
}

// Composer deploys are replay-only: they apply committed migrations and never
// create schema, so the scaffold authors the baseline itself.
async function planBaselineMigration(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<void> {
  await runPrismaCli(context, projectDir, ["migration", "plan", "--name", "init"]);
}

function formatNextSteps(steps: CreateNextStep[]): string {
  return steps.map((step) => `${step.command}\n  ${step.description}`).join("\n\n");
}

function formatPlatformTarget(name: string | null, id: string): string {
  return name ? `${name} (${id})` : id;
}

function formatProjectSummary(options: {
  createdProjectPath?: string;
  deployment?: ComposerDeployResult;
}): string {
  const lines: string[] = [];
  if (options.createdProjectPath) {
    lines.push(`Path: ${path.resolve(options.createdProjectPath)}`);
  }
  if (options.deployment?.workspace) {
    lines.push(
      `Workspace: ${formatPlatformTarget(
        options.deployment.workspace.name,
        options.deployment.workspace.id,
      )}`,
    );
  }
  if (options.deployment) {
    lines.push(
      `Project: ${
        options.deployment.project.id
          ? formatPlatformTarget(options.deployment.project.name, options.deployment.project.id)
          : options.deployment.project.name
      }`,
    );
    lines.push(`App: ${options.deployment.appUrl ?? options.deployment.appName}`);
    if (options.deployment.project.consoleUrl) {
      lines.push(`Console: ${options.deployment.project.consoleUrl}`);
    }
  }
  return lines.join("\n");
}

function buildNextSteps(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions,
): CreateNextStep[] {
  const nextSteps = [...(options.prependNextSteps ?? [])];
  if (context.databaseProvider === "mongo") {
    nextSteps.push({
      command: "Set MONGODB_URL in your environment",
      description: "Composer uses this secret when deploying the MongoDB template.",
    });
  }
  if (options.includeDevNextStep) {
    nextSteps.push({
      command: getRunScriptCommand(
        context.packageManager,
        context.packageManager === "deno" ? "dev" : "dev:composer",
      ),
      description:
        context.packageManager === "deno"
          ? "Start the Deno app after setting DATABASE_URL in .env."
          : "Build and start the app with Prisma Composer locally.",
    });
  }
  if (context.packageManager === "deno") {
    return nextSteps;
  }
  nextSteps.push({
    command: getRunScriptCommand(context.packageManager, "deploy"),
    description: "Build and deploy the app with Prisma Composer.",
  });
  return nextSteps;
}

export async function executePrismaSetupContext(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
): Promise<PrismaSetupExecutionResult> {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const projectName = options.projectName ?? path.basename(projectDir);
  const template = options.template ?? "minimal";
  const progress = context.verbose
    ? undefined
    : (options.progressSpinner ?? spinner({ output: context.output }));
  const ownsProgress = progress !== undefined && !options.progressSpinner;
  let gitInitialization: GitInitializationResult | undefined;
  let setupStage: CreateFailureStage = "initialize_prisma";
  let setupReason: CreateFailureReason = "prisma_init_failed";
  if (ownsProgress) progress.start("Creating Prisma 8 project...");

  try {
    progress?.message("Preparing Prisma 8 project files...");
    await runPrismaInit(context, projectDir);

    setupStage = "configure_project";
    setupReason = "project_configuration_failed";
    await scaffoldCreateSharedTemplates({
      projectDir,
      projectName,
      template,
      provider: context.databaseProvider,
      authoring: context.authoring,
      packageManager: context.packageManager,
    });
    await writePrismaDependencies(
      context.databaseProvider,
      context.packageManager,
      context.authoring,
      projectDir,
    );
    await ensureComposerTypeScriptOptions(projectDir);
    if (context.databaseProvider === "mongo") await ensureMongoEnvironment(projectDir);
    if (context.packageManager !== "deno") {
      await ensureGitignoreEntry(projectDir, "/.alchemy");
      await ensureGitignoreEntry(projectDir, "/.prisma-composer");
    }

    progress?.message(
      `Installing dependencies with ${getInstallCommand(context.packageManager)}...`,
    );
    setupStage = "install_dependencies";
    setupReason = "dependency_install_failed";
    await installProjectDependencies(context.packageManager, projectDir, {
      verbose: context.verbose,
      json: context.json,
    });

    progress?.message("Installing Prisma agent skills...");
    setupStage = "initialize_agent_skills";
    setupReason = "agent_skills_init_failed";
    await initializeAgentSkills(context, projectDir);

    progress?.message("Generating Prisma 8 contract artifacts...");
    setupStage = "emit_contract";
    setupReason = "contract_emit_failed";
    await emitContract(context, projectDir);

    if (context.databaseProvider === "postgres") {
      progress?.message("Authoring the baseline migration...");
      setupStage = "plan_migration";
      setupReason = "migration_plan_failed";
      await planBaselineMigration(context, projectDir);
    }

    if (options.initializeGit) {
      progress?.message("Initializing Git repository...");
      setupStage = "initialize_git";
      setupReason = "git_initialization_failed";
      gitInitialization = await initializeGitRepository(projectDir);
    }
    progress?.stop("Prisma 8 project ready.");
    if (gitInitialization?.status === "initialized" && context.verbose) {
      log.success("Initialized Git repository with an initial commit.", { output: context.output });
    } else if (gitInitialization?.status === "skipped") {
      log.warn(`Could not initialize Git repository: ${gitInitialization.reason}`, {
        output: context.output,
      });
    }
  } catch (error) {
    progress?.error("Could not create Prisma 8 project.");
    cancel(getErrorMessage(error), { output: context.output });
    return {
      ok: false,
      stage: setupStage,
      reason: getCreateFailureReason(error, setupReason),
      error,
      errorReported: true,
    };
  }

  let deployment: ComposerDeployResult | undefined;
  if (context.shouldDeploy) {
    const deploymentResult = await deployNewProjectWithComposer({
      appName: projectName,
      packageManager: context.packageManager,
      projectDir,
      shouldPromptForWorkspace: context.shouldPromptForWorkspace,
      verbose: context.verbose,
      output: context.output,
      allowInteractiveLogin: !context.json,
      json: context.json,
      ...(context.workspace ? { workspace: context.workspace } : {}),
    });
    if (!deploymentResult.ok) {
      if (deploymentResult.cancelled) {
        return {
          ok: false,
          cancelled: true,
          stage: deploymentResult.stage,
          errorReported: true,
        };
      }
      return {
        ok: false,
        stage: deploymentResult.stage,
        reason: deploymentResult.reason,
        error: deploymentResult.error,
        errorReported: true,
      };
    }
    deployment = deploymentResult.deployment;
  }

  const nextSteps = buildNextSteps(context, options);
  const warnings =
    gitInitialization?.status === "skipped"
      ? [`Could not initialize Git repository: ${gitInitialization.reason}`]
      : [];

  const projectSummary = formatProjectSummary({
    createdProjectPath: options.createdProjectPath,
    deployment,
  });
  if (projectSummary) {
    note(projectSummary, context.shouldDeploy ? "Deployment" : "Project", {
      output: context.output,
    });
  }
  note(formatNextSteps(nextSteps), "Next steps", { output: context.output });
  outro(context.shouldDeploy ? "Prisma 8 app deployed." : "Prisma 8 project ready.", {
    output: context.output,
  });
  return {
    ok: true,
    deployment: deployment ?? null,
    nextSteps,
    ...(gitInitialization ? { gitInitialization } : {}),
    warnings,
  };
}
