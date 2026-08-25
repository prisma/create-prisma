import { cancel, confirm, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import { PRISMA_DENO_CLI_PACKAGE, PRISMA_PLATFORM_CLI_PACKAGE } from "../constants/dependencies";
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
import {
  detectPackageManager,
  getInstallCommand,
  getPackageExecutionArgs,
  getRunScriptCommand,
} from "../utils/package-manager";
import { deployNewProjectWithComposer, type ComposerDeployResult } from "./deploy-with-composer";
import { initializeGitRepository, type GitInitializationResult } from "./initialize-git";
import { installProjectDependencies, writePrismaDependencies } from "./install";

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgres";
const DEFAULT_AUTHORING: AuthoringStyle = "psl";

type NextStep = {
  command: string;
  description: string;
};

type PrismaSetupRunOptions = {
  prependNextSteps?: NextStep[];
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
  databaseProvider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager: PackageManager;
  shouldDeploy: boolean;
  shouldPromptForWorkspace: boolean;
  workspace?: string;
};

async function promptForDatabaseProvider(): Promise<DatabaseProvider | undefined> {
  const databaseProvider = await select({
    message: "Select your database",
    initialValue: DEFAULT_DATABASE_PROVIDER,
    options: [
      { value: "postgres", label: "PostgreSQL", hint: "Prisma Postgres with Composer" },
      { value: "mongo", label: "MongoDB", hint: "Connect an existing MongoDB database" },
    ],
  });
  if (isCancel(databaseProvider)) {
    cancel("Operation cancelled.");
    return;
  }
  return DatabaseProviderSchema.parse(databaseProvider);
}

async function promptForAuthoringStyle(): Promise<AuthoringStyle | undefined> {
  const authoring = await select({
    message: "Choose contract authoring style",
    initialValue: DEFAULT_AUTHORING,
    options: [
      { value: "psl", label: "PSL", hint: "Prisma schema syntax" },
      { value: "typescript", label: "TypeScript", hint: "TypeScript contract builder" },
    ],
  });
  if (isCancel(authoring)) {
    cancel("Operation cancelled.");
    return;
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
): Promise<PackageManager | undefined> {
  const packageManager = await select({
    message: "Choose package manager",
    initialValue: detected,
    options: packageManagers.map((value) => ({
      value,
      label: value,
      hint: getPackageManagerHint(value, detected),
    })),
  });
  if (isCancel(packageManager)) {
    cancel("Operation cancelled.");
    return;
  }
  return PackageManagerSchema.parse(packageManager);
}

async function promptForDeployment(): Promise<boolean | undefined> {
  const shouldDeploy = await confirm({
    message: "Deploy to Prisma now?",
    initialValue: true,
  });
  if (isCancel(shouldDeploy)) {
    cancel("Operation cancelled.");
    return;
  }
  return Boolean(shouldDeploy);
}

export async function collectPrismaSetupContext(
  input: PrismaSetupCommandInput,
  options: { projectDir?: string; template?: CreateTemplate } = {},
): Promise<PrismaSetupContext | undefined> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const useDefaults = input.yes === true;

  const databaseProvider =
    input.provider ?? (useDefaults ? DEFAULT_DATABASE_PROVIDER : await promptForDatabaseProvider());
  if (!databaseProvider) return;

  const authoring =
    input.authoring ?? (useDefaults ? DEFAULT_AUTHORING : await promptForAuthoringStyle());
  if (!authoring) return;

  const detectedPackageManager = await detectPackageManager(projectDir);
  const packageManager =
    input.packageManager ??
    (useDefaults ? detectedPackageManager : await promptForPackageManager(detectedPackageManager));
  if (!packageManager) return;

  if (packageManager === "deno" && databaseProvider !== "postgres") {
    throw new Error("Deno support currently requires PostgreSQL.");
  }
  if (packageManager === "deno" && options.template && options.template !== "minimal") {
    throw new Error("Deno support currently requires the minimal template.");
  }
  if (packageManager === "deno" && input.deploy === true) {
    throw new Error("Prisma Compute does not support Deno deployments yet. Use --no-deploy.");
  }

  const shouldDeploy =
    packageManager === "deno"
      ? false
      : (input.deploy ?? (useDefaults ? false : await promptForDeployment()));
  if (shouldDeploy === undefined) return;

  return {
    projectDir,
    verbose: input.verbose === true,
    databaseProvider,
    authoring,
    packageManager,
    shouldDeploy,
    shouldPromptForWorkspace: !useDefaults,
    ...(input.workspace ? { workspace: input.workspace } : {}),
  };
}

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
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
  const args =
    context.packageManager === "deno"
      ? [
          "init",
          "--yes",
          "--no-interactive",
          "--target",
          getInitTarget(context.databaseProvider),
          "--authoring",
          context.authoring,
          "--schema-path",
          getContractPath(context.authoring),
          "--no-install",
          "--no-skill",
        ]
      : [
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
          "--skip-skills",
        ];
  const invocation = getPrismaCliInvocation(context.packageManager, args);
  if (context.verbose) log.step(`Running ${[invocation.command, ...invocation.args].join(" ")}`);
  await execa(invocation.command, invocation.args, {
    cwd: projectDir,
    stdio: context.verbose ? "inherit" : "pipe",
    env: { ...process.env, CI: "1" },
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
  if (context.verbose) log.step(`Running ${[invocation.command, ...invocation.args].join(" ")}`);
  await execa(invocation.command, invocation.args, {
    cwd: projectDir,
    stdio: context.verbose ? "inherit" : "pipe",
    env: { ...process.env, CI: "1" },
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

async function emitContract(context: PrismaSetupContext, projectDir: string): Promise<void> {
  const invocation = getPrismaCliInvocation(context.packageManager, ["contract", "emit"]);
  if (context.verbose) {
    log.step([invocation.command, ...invocation.args].join(" "));
  }
  await execa(invocation.command, invocation.args, {
    cwd: projectDir,
    stdio: context.verbose ? "inherit" : "pipe",
  });
}

// Composer deploys are replay-only: they apply committed migrations and never
// create schema. The scaffold authors the baseline (empty → the emitted
// contract) so the project's first deploy always has a migration path.
async function planBaselineMigration(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<void> {
  if (context.databaseProvider !== "postgres") return;
  const invocation = getPrismaCliInvocation(context.packageManager, [
    "migration",
    "plan",
    "--name",
    "init",
  ]);
  if (context.verbose) {
    log.step([invocation.command, ...invocation.args].join(" "));
  }
  await execa(invocation.command, invocation.args, {
    cwd: projectDir,
    stdio: context.verbose ? "inherit" : "pipe",
  });
}

function formatNextSteps(steps: NextStep[]): string {
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

function buildNextSteps(context: PrismaSetupContext, options: PrismaSetupRunOptions): NextStep[] {
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
): Promise<boolean> {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const projectName = options.projectName ?? path.basename(projectDir);
  const template = options.template ?? "minimal";
  const progress = context.verbose ? undefined : (options.progressSpinner ?? spinner());
  const ownsProgress = progress !== undefined && !options.progressSpinner;
  let gitInitialization: GitInitializationResult | undefined;
  if (ownsProgress) progress.start("Creating Prisma 8 project...");

  try {
    progress?.message("Preparing Prisma 8 project files...");
    await runPrismaInit(context, projectDir);

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
    await installProjectDependencies(context.packageManager, projectDir, {
      verbose: context.verbose,
    });

    progress?.message("Installing Prisma agent skills...");
    await initializeAgentSkills(context, projectDir);

    progress?.message("Generating Prisma 8 contract artifacts...");
    await emitContract(context, projectDir);

    progress?.message("Authoring the baseline migration...");
    await planBaselineMigration(context, projectDir);

    if (options.initializeGit) {
      progress?.message("Initializing Git repository...");
      gitInitialization = await initializeGitRepository(projectDir);
    }
    progress?.stop("Prisma 8 project ready.");
    if (gitInitialization?.status === "initialized" && context.verbose) {
      log.success("Initialized Git repository with an initial commit.");
    } else if (gitInitialization?.status === "skipped") {
      log.warn(`Could not initialize Git repository: ${gitInitialization.reason}`);
    }
  } catch (error) {
    progress?.error("Could not create Prisma 8 project.");
    cancel(getCommandErrorMessage(error));
    return false;
  }

  let deployment: ComposerDeployResult | undefined;
  if (context.shouldDeploy) {
    deployment = await deployNewProjectWithComposer({
      appName: projectName,
      packageManager: context.packageManager,
      projectDir,
      shouldPromptForWorkspace: context.shouldPromptForWorkspace,
      verbose: context.verbose,
      ...(context.workspace ? { workspace: context.workspace } : {}),
    });
    if (!deployment) return false;
  }

  const projectSummary = formatProjectSummary({
    createdProjectPath: options.createdProjectPath,
    deployment,
  });
  if (projectSummary) note(projectSummary, context.shouldDeploy ? "Deployment" : "Project");
  note(formatNextSteps(buildNextSteps(context, options)), "Next steps");
  outro(context.shouldDeploy ? "Prisma 8 app deployed." : "Prisma 8 project ready.");
  return true;
}
