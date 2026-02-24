import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import { execa } from "execa";
import path from "node:path";

import {
  canReusePrismaFiles,
  findExistingPrismaFiles,
  initializePrismaFiles,
} from "../tasks/init-prisma";
import {
  installProjectDependencies,
  writePrismaDependencies,
} from "../tasks/install";
import {
  getCreateDbCommand,
  provisionPrismaPostgres,
} from "../tasks/prisma-postgres";
import {
  DatabaseProviderSchema,
  InitCommandInputSchema,
  PackageManagerSchema,
  type DatabaseProvider,
  type DependencyWriteResult,
  type InitCommandResult,
  type InitCommandInput,
  type InitPrismaResult,
  type InitPromptContext,
  type InitRunOptions,
  type PackageManager,
  type PrismaGenerateResult,
  type PrismaPostgresProvisionResult,
  type PrismaFilesMode,
  type SchemaPreset,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
  getPrismaCliArgs,
  getPrismaCliCommand,
  getRunScriptCommand,
} from "../utils/package-manager";
import { getCreatePrismaIntro } from "../ui/branding";

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgresql";
const DEFAULT_SCHEMA_PRESET: SchemaPreset = "empty";
const DEFAULT_PRISMA_POSTGRES = true;
const DEFAULT_INSTALL = true;
const DEFAULT_GENERATE = true;

async function promptForDatabaseProvider(): Promise<DatabaseProvider | undefined> {
  const databaseProvider = await select({
    message: "Select your database",
    initialValue: DEFAULT_DATABASE_PROVIDER,
    options: [
      { value: "postgresql", label: "PostgreSQL", hint: "Default" },
      { value: "mysql", label: "MySQL" },
      { value: "sqlite", label: "SQLite" },
      { value: "sqlserver", label: "SQL Server" },
      { value: "cockroachdb", label: "CockroachDB" },
    ],
  });

  if (isCancel(databaseProvider)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return DatabaseProviderSchema.parse(databaseProvider);
}

function getPackageManagerHint(
  option: PackageManager,
  detected: PackageManager
): string | undefined {
  if (option === detected) {
    return "Detected";
  }

  if (option === "bun") {
    return "Fast runtime + package manager";
  }

  return undefined;
}

async function promptForPackageManager(
  detectedPackageManager: PackageManager
): Promise<PackageManager | undefined> {
  const packageManager = await select({
    message: "Choose package manager",
    initialValue: detectedPackageManager,
    options: [
      {
        value: "npm",
        label: "npm",
        hint: getPackageManagerHint("npm", detectedPackageManager),
      },
      {
        value: "pnpm",
        label: "pnpm",
        hint: getPackageManagerHint("pnpm", detectedPackageManager),
      },
      {
        value: "bun",
        label: "bun",
        hint: getPackageManagerHint("bun", detectedPackageManager),
      },
    ],
  });

  if (isCancel(packageManager)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return PackageManagerSchema.parse(packageManager);
}

async function promptForDependencyInstall(
  packageManager: PackageManager
): Promise<boolean | undefined> {
  const installCommand = getInstallCommand(packageManager);
  const shouldInstall = await confirm({
    message: `Install dependencies now with ${installCommand}?`,
    initialValue: true,
  });

  if (isCancel(shouldInstall)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return Boolean(shouldInstall);
}

async function promptForPrismaPostgres(): Promise<boolean | undefined> {
  const shouldUsePrismaPostgres = await confirm({
    message:
      "Use Prisma Postgres and auto-generate DATABASE_URL with create-db?",
    initialValue: true,
  });

  if (isCancel(shouldUsePrismaPostgres)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return Boolean(shouldUsePrismaPostgres);
}

async function promptForPrismaFilesMode(
  existingFiles: string[],
  canReuseExistingPrismaFiles: boolean,
  baseDir: string
): Promise<PrismaFilesMode | undefined> {
  const existingFileList = existingFiles
    .map((filePath) => formatCreatedPath(filePath, baseDir))
    .join(", ");

  const mode = await select({
    message: `Prisma already exists (${existingFileList}). How should we continue?`,
    initialValue: canReuseExistingPrismaFiles ? "reuse" : "overwrite",
    options: canReuseExistingPrismaFiles
      ? [
          {
            value: "reuse",
            label: "Keep existing Prisma files",
            hint: "Recommended",
          },
          {
            value: "overwrite",
            label: "Overwrite Prisma files",
          },
          {
            value: "cancel",
            label: "Cancel",
          },
        ]
      : [
          {
            value: "overwrite",
            label: "Repair and overwrite Prisma files",
            hint: "Recommended",
          },
          {
            value: "cancel",
            label: "Cancel",
          },
        ],
  });

  if (isCancel(mode)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  if (mode === "cancel") {
    cancel("Operation cancelled.");
    return undefined;
  }

  if (mode !== "reuse" && mode !== "overwrite") {
    cancel("Operation cancelled.");
    return undefined;
  }

  return mode;
}

function formatCreatedPath(filePath: string, baseDir: string): string {
  return path.relative(baseDir, filePath);
}

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    if (stderr.length > 0) {
      return stderr;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

export async function collectInitContext(
  rawInput: InitCommandInput = {},
  options: Pick<InitRunOptions, "skipIntro" | "projectDir"> = {}
): Promise<InitPromptContext | undefined> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const input = InitCommandInputSchema.parse(rawInput);
  const useDefaults = input.yes === true;
  const verbose = input.verbose === true;
  const shouldGenerate = input.generate ?? DEFAULT_GENERATE;

  if (!options.skipIntro) {
    intro(getCreatePrismaIntro());
  }

  let prismaFilesMode: PrismaFilesMode = "create";
  const existingPrismaFiles = findExistingPrismaFiles(projectDir);
  const canReuseExistingPrismaFiles = canReusePrismaFiles(projectDir);
  if (existingPrismaFiles.length > 0) {
    if (useDefaults) {
      prismaFilesMode = canReuseExistingPrismaFiles ? "reuse" : "overwrite";
    } else {
      const selectedMode = await promptForPrismaFilesMode(
        existingPrismaFiles,
        canReuseExistingPrismaFiles,
        projectDir
      );
      if (!selectedMode) {
        return;
      }
      prismaFilesMode = selectedMode;
    }
  }

  const databaseProvider =
    input.provider ??
    (useDefaults ? DEFAULT_DATABASE_PROVIDER : await promptForDatabaseProvider());
  if (!databaseProvider) {
    return;
  }

  const schemaPreset =
    input.schemaPreset ?? DEFAULT_SCHEMA_PRESET;

  const databaseUrl = input.databaseUrl;
  let shouldUsePrismaPostgres = false;

  if (databaseProvider === "postgresql" && !databaseUrl) {
    const prismaPostgresChoice =
      input.prismaPostgres ??
      (useDefaults ? DEFAULT_PRISMA_POSTGRES : await promptForPrismaPostgres());
    if (prismaPostgresChoice === undefined) {
      return;
    }

    shouldUsePrismaPostgres = prismaPostgresChoice;
  }

  const detectedPackageManager = await detectPackageManager(projectDir);
  const packageManager =
    input.packageManager ??
    (useDefaults
      ? detectedPackageManager
      : await promptForPackageManager(detectedPackageManager));
  if (!packageManager) {
    return;
  }

  const shouldInstall =
    input.install ??
    (useDefaults
      ? DEFAULT_INSTALL
      : await promptForDependencyInstall(packageManager));
  if (shouldInstall === undefined) {
    return;
  }

  return {
    projectDir,
    verbose,
    shouldGenerate,
    prismaFilesMode,
    databaseProvider,
    schemaPreset,
    databaseUrl,
    shouldUsePrismaPostgres,
    packageManager,
    shouldInstall,
  };
}

async function provisionPrismaPostgresIfNeeded(
  context: InitPromptContext,
  projectDir: string
): Promise<PrismaPostgresProvisionResult | undefined> {
  if (!context.shouldUsePrismaPostgres) {
    return {
      databaseUrl: context.databaseUrl,
    };
  }

  const createDbCommand = getCreateDbCommand(context.packageManager);
  const prismaPostgresSpinner = spinner();
  prismaPostgresSpinner.start(
    `Provisioning Prisma Postgres with ${createDbCommand}...`
  );

  try {
    const prismaPostgresResult =
      await provisionPrismaPostgres(context.packageManager, projectDir);

    prismaPostgresSpinner.stop("Prisma Postgres database provisioned.");
    return {
      databaseUrl: prismaPostgresResult.databaseUrl,
      claimUrl: prismaPostgresResult.claimUrl,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    prismaPostgresSpinner.stop("Could not provision Prisma Postgres.");

    return {
      databaseUrl: context.databaseUrl,
      warning: `Prisma Postgres provisioning failed: ${errorMessage}`,
    };
  }
}

async function writeDependenciesForContext(
  context: InitPromptContext,
  projectDir: string
): Promise<DependencyWriteResult | undefined> {
  try {
    return await writePrismaDependencies(context.databaseProvider, projectDir);
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return;
  }
}

async function installDependenciesForContext(
  context: InitPromptContext,
  projectDir: string
): Promise<boolean> {
  if (!context.shouldInstall) {
    return true;
  }

  const installCommand = getInstallCommand(context.packageManager);
  if (context.verbose) {
    log.step(`Running ${installCommand}`);
    try {
      await installProjectDependencies(context.packageManager, projectDir, {
        verbose: context.verbose,
      });
      log.success("Dependencies installed.");
      return true;
    } catch (error) {
      cancel(`Failed to run ${installCommand}: ${getCommandErrorMessage(error)}`);
      return false;
    }
  }

  const installSpinner = spinner();
  installSpinner.start(`Running ${installCommand}...`);
  try {
    await installProjectDependencies(context.packageManager, projectDir, {
      verbose: context.verbose,
    });
    installSpinner.stop("Dependencies installed.");
    return true;
  } catch (error) {
    installSpinner.stop("Could not install dependencies.");
    cancel(`Failed to run ${installCommand}: ${getCommandErrorMessage(error)}`);
    return false;
  }
}

async function initializePrismaFilesForContext(
  context: InitPromptContext,
  projectDir: string,
  provisionResult: PrismaPostgresProvisionResult
): Promise<InitPrismaResult | undefined> {
  const initSpinner = spinner();
  initSpinner.start("Preparing Prisma files...");

  try {
    const initResult = await initializePrismaFiles({
      provider: context.databaseProvider,
      databaseUrl: provisionResult.databaseUrl,
      claimUrl: provisionResult.claimUrl,
      schemaPreset: context.schemaPreset,
      prismaFilesMode: context.prismaFilesMode,
      projectDir,
    });

    if (initResult.prismaFilesMode === "overwrite") {
      initSpinner.stop("Prisma files updated.");
    } else if (initResult.prismaFilesMode === "reuse") {
      initSpinner.stop("Using existing Prisma files.");
    } else {
      initSpinner.stop("Prisma files ready.");
    }

    return initResult;
  } catch (error) {
    initSpinner.stop("Could not prepare Prisma files.");
    cancel(getCommandErrorMessage(error));
    return;
  }
}

async function generatePrismaClientForContext(
  context: InitPromptContext,
  projectDir: string
): Promise<PrismaGenerateResult> {
  if (!context.shouldGenerate) {
    return {
      didGenerateClient: false,
    };
  }

  const generateCommand = getPrismaCliCommand(context.packageManager, [
    "generate",
  ]);
  if (context.verbose) {
    log.step(`Running ${generateCommand}`);
  }

  const generateSpinner = context.verbose ? undefined : spinner();
  generateSpinner?.start("Generating Prisma Client...");
  try {
    const generateArgs = getPrismaCliArgs(context.packageManager, ["generate"]);
    await execa(generateArgs.command, generateArgs.args, {
      cwd: projectDir,
      stdio: context.verbose ? "inherit" : "pipe",
    });
    if (context.verbose) {
      log.success("Prisma Client generated.");
    } else {
      generateSpinner?.stop("Prisma Client generated.");
    }

    return {
      didGenerateClient: true,
    };
  } catch (error) {
    if (context.verbose) {
      log.warn("Could not generate Prisma Client.");
    } else {
      generateSpinner?.stop("Could not generate Prisma Client.");
    }

    return {
      didGenerateClient: false,
      warning: `Prisma generate failed: ${getCommandErrorMessage(error)}`,
    };
  }
}

function buildWarningLines(
  provisionWarning: string | undefined,
  generateWarning: string | undefined
): string[] {
  const warningLines: string[] = [];

  if (provisionWarning) {
    warningLines.push(`- ${provisionWarning}`);
  }
  if (generateWarning) {
    warningLines.push(`- ${generateWarning}`);
  }

  return warningLines;
}

function buildNextStepsForContext(opts: {
  context: InitPromptContext;
  options: InitRunOptions;
  didGenerateClient: boolean;
}): string[] {
  const { context, options, didGenerateClient } = opts;
  const nextSteps: string[] = [...(options.prependNextSteps ?? [])];

  if (!context.shouldInstall) {
    nextSteps.push(`- ${getInstallCommand(context.packageManager)}`);
  }
  if (!didGenerateClient || !context.shouldGenerate) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:generate")}`);
  }
  nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:migrate")}`);
  if (options.includeDevNextStep) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "dev")}`);
  }

  return nextSteps;
}

export async function executeInitContext(
  context: InitPromptContext,
  options: InitRunOptions = {}
): Promise<InitCommandResult | undefined> {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const provisionResult = await provisionPrismaPostgresIfNeeded(
    context,
    projectDir
  );
  if (!provisionResult) {
    return;
  }

  const dependencyWriteResult = await writeDependenciesForContext(
    context,
    projectDir
  );
  if (!dependencyWriteResult) {
    return;
  }

  const dependenciesInstalled = await installDependenciesForContext(
    context,
    projectDir
  );
  if (!dependenciesInstalled) {
    return;
  }

  const initResult = await initializePrismaFilesForContext(
    context,
    projectDir,
    provisionResult
  );
  if (!initResult) {
    return;
  }

  const generateResult = await generatePrismaClientForContext(context, projectDir);

  const warningLines = buildWarningLines(
    provisionResult.warning,
    generateResult.warning
  );
  const nextSteps = buildNextStepsForContext({
    context,
    options,
    didGenerateClient: generateResult.didGenerateClient,
  });

  const warningSection =
    warningLines.length > 0 ? `\n\n${warningLines.join("\n")}` : "";

  outro(`Setup complete.${warningSection}

Next steps:
${nextSteps.join("\n")}`);

  return {
    packageManager: context.packageManager,
  };
}

export async function runInitCommand(
  rawInput: InitCommandInput = {},
  options: InitRunOptions = {}
): Promise<InitCommandResult | undefined> {
  try {
    const context = await collectInitContext(rawInput, options);
    if (!context) {
      return;
    }

    return executeInitContext(context, options);
  } catch (error) {
    cancel(
      `Init command failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }
}
