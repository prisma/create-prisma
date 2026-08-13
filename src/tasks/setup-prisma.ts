import { cancel, confirm, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import { scaffoldCreateSharedTemplates } from "../templates/render-create-template";
import {
  AuthoringStyleSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
  type AuthoringStyle,
  type CreateTemplate,
  type DatabaseProvider,
  type PackageManager,
  type PrismaSetupCommandInput,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
  getLocalPackageBinaryArgs,
  getLocalPackageBinaryCommand,
  getPackageExecutionArgs,
  getRunScriptCommand,
} from "../utils/package-manager";
import { deployWithComposer } from "./deploy-with-composer";
import { installProjectDependencies, writePrismaDependencies } from "./install";

const PRISMA_CLI_PACKAGE = "@prisma/cli@next";
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
  progressSpinner?: ReturnType<typeof spinner>;
};

export type PrismaSetupContext = {
  projectDir: string;
  verbose: boolean;
  databaseProvider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager: PackageManager;
  shouldDeploy: boolean;
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
  } satisfies Record<PackageManager, string>;
  return option === detected ? `Detected; ${hints[option]}` : hints[option];
}

async function promptForPackageManager(
  detected: PackageManager,
): Promise<PackageManager | undefined> {
  const packageManager = await select({
    message: "Choose package manager",
    initialValue: detected,
    options: (["npm", "pnpm", "yarn", "bun"] as const).map((value) => ({
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
    initialValue: false,
  });
  if (isCancel(shouldDeploy)) {
    cancel("Operation cancelled.");
    return;
  }
  return Boolean(shouldDeploy);
}

export async function collectPrismaSetupContext(
  input: PrismaSetupCommandInput,
  options: { projectDir?: string } = {},
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

  const shouldDeploy = input.deploy ?? (useDefaults ? false : await promptForDeployment());
  if (shouldDeploy === undefined) return;

  return {
    projectDir,
    verbose: input.verbose === true,
    databaseProvider,
    authoring,
    packageManager,
    shouldDeploy,
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
  return getPackageExecutionArgs(packageManager, [PRISMA_CLI_PACKAGE, ...args]);
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
    "--skip-skills",
  ];
  const invocation = getPrismaCliInvocation(context.packageManager, args);
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
  const args = getLocalPackageBinaryArgs(context.packageManager, "prisma-next", [
    "contract",
    "emit",
  ]);
  if (context.verbose) {
    log.step(
      getLocalPackageBinaryCommand(context.packageManager, "prisma-next", ["contract", "emit"]),
    );
  }
  await execa(args.command, args.args, {
    cwd: projectDir,
    stdio: context.verbose ? "inherit" : "pipe",
  });
}

function formatNextSteps(steps: NextStep[]): string {
  return steps.map((step) => `${step.command}\n  ${step.description}`).join("\n\n");
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
      command: getRunScriptCommand(context.packageManager, "dev:composer"),
      description: "Build and start the app with Prisma Composer locally.",
    });
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
  if (ownsProgress) progress.start("Creating Prisma Next project...");

  try {
    progress?.message("Preparing Prisma Next project files...");
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

    progress?.message(
      `Installing dependencies with ${getInstallCommand(context.packageManager)}...`,
    );
    await installProjectDependencies(context.packageManager, projectDir, {
      verbose: context.verbose,
    });

    progress?.message("Generating Prisma Next contract artifacts...");
    await emitContract(context, projectDir);
    progress?.stop("Prisma Next project ready.");
  } catch (error) {
    progress?.stop("Could not create Prisma Next project.");
    cancel(getCommandErrorMessage(error));
    return false;
  }

  if (context.shouldDeploy) {
    const didDeploy = await deployWithComposer({
      packageManager: context.packageManager,
      projectDir,
      verbose: context.verbose,
    });
    if (!didDeploy) return false;
  }

  if (options.createdProjectPath) note(path.resolve(options.createdProjectPath), "Project path");
  note(formatNextSteps(buildNextSteps(context, options)), "Next steps");
  outro(context.shouldDeploy ? "Prisma Next app deployed." : "Prisma Next setup complete.");
  return true;
}
