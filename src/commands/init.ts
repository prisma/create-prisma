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
  type InitPrismaResult,
  type PrismaFilesMode,
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
  SchemaPresetSchema,
  type DatabaseProvider,
  type InitCommandInput,
  type PackageManager,
  type SchemaPreset,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
  getPrismaCliArgs,
  getPrismaCliCommand,
} from "../utils/package-manager";

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
    cancel("Cancelled.");
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
    cancel("Cancelled.");
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
    cancel("Cancelled.");
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
    cancel("Cancelled.");
    return undefined;
  }

  return Boolean(shouldUsePrismaPostgres);
}

async function promptContinueWithDefaultPostgresUrl(): Promise<boolean | undefined> {
  const shouldContinue = await confirm({
    message: "Continue with default local PostgreSQL DATABASE_URL instead?",
    initialValue: true,
  });

  if (isCancel(shouldContinue)) {
    cancel("Cancelled.");
    return undefined;
  }

  return Boolean(shouldContinue);
}

async function promptForPrismaFilesMode(
  existingFiles: string[],
  canReuseExistingPrismaFiles: boolean
): Promise<PrismaFilesMode | undefined> {
  const existingFileList = existingFiles
    .map((filePath) => formatCreatedPath(filePath))
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

  if (isCancel(mode) || mode === "cancel") {
    cancel("Cancelled.");
    return undefined;
  }

  if (mode !== "reuse" && mode !== "overwrite") {
    cancel("Cancelled.");
    return undefined;
  }

  return mode;
}

async function promptForSchemaPreset(
  defaultSchemaPreset: SchemaPreset
): Promise<SchemaPreset | undefined> {
  const schemaPreset = await select({
    message: "Choose schema preset",
    initialValue: defaultSchemaPreset,
    options: [
      {
        value: "empty",
        label: "Empty",
        hint: "Datasource only",
      },
      {
        value: "basic",
        label: "Basic",
        hint: "Adds a User model",
      },
    ],
  });

  if (isCancel(schemaPreset)) {
    cancel("Cancelled.");
    return undefined;
  }

  return SchemaPresetSchema.parse(schemaPreset);
}

function formatEnvStatus(
  status: "created" | "appended" | "existing" | "updated",
  envPath: string,
  envVarName: string
): string {
  const relativeEnvPath = path.relative(process.cwd(), envPath) || ".env";
  switch (status) {
    case "created":
      return `Created ${relativeEnvPath} with ${envVarName}`;
    case "appended":
      return `Appended ${envVarName} to ${relativeEnvPath}`;
    case "existing":
      return `Kept existing ${envVarName} in ${relativeEnvPath}`;
    case "updated":
      return `Updated ${envVarName} in ${relativeEnvPath}`;
    default:
      return `Updated ${relativeEnvPath}`;
  }
}

function formatGitignoreStatus(
  status: "created" | "appended" | "existing",
  gitignorePath: string
): string {
  const relativePath = path.relative(process.cwd(), gitignorePath) || ".gitignore";
  switch (status) {
    case "created":
      return `Created ${relativePath} with prisma/generated`;
    case "appended":
      return `Added prisma/generated to ${relativePath}`;
    case "existing":
      return `Kept existing prisma/generated ignore in ${relativePath}`;
    default:
      return `Updated ${relativePath}`;
  }
}

function formatCreatedPath(filePath: string): string {
  return path.relative(process.cwd(), filePath);
}

function formatFileAction(action: PrismaFilesMode): "Created" | "Wrote" | "Kept existing" {
  switch (action) {
    case "create":
      return "Created";
    case "overwrite":
      return "Wrote";
    case "reuse":
      return "Kept existing";
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`Unsupported file action: ${String(exhaustiveCheck)}`);
    }
  }
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

export async function runInitCommand(
  rawInput: InitCommandInput = {},
  options: {
    skipIntro?: boolean;
  } = {}
): Promise<void> {
  const input = InitCommandInputSchema.parse(rawInput);
  const useDefaults = input.yes === true;
  const verbose = input.verbose === true;
  const shouldGenerate = input.generate ?? DEFAULT_GENERATE;

  if (!options.skipIntro) {
    intro("Create Prisma");
  }

  let prismaFilesMode: PrismaFilesMode = "create";
  const existingPrismaFiles = findExistingPrismaFiles(process.cwd());
  const canReuseExistingPrismaFiles = canReusePrismaFiles(process.cwd());
  if (existingPrismaFiles.length > 0) {
    if (useDefaults) {
      prismaFilesMode = canReuseExistingPrismaFiles ? "reuse" : "overwrite";
    } else {
      const selectedMode = await promptForPrismaFilesMode(
        existingPrismaFiles,
        canReuseExistingPrismaFiles
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
    input.schemaPreset ??
    (useDefaults
      ? DEFAULT_SCHEMA_PRESET
      : await promptForSchemaPreset(DEFAULT_SCHEMA_PRESET));
  if (!schemaPreset) {
    return;
  }

  let databaseUrl = input.databaseUrl;
  let shouldUsePrismaPostgres = false;
  let claimUrl: string | undefined;
  let deletionDate: string | undefined;
  let prismaPostgresWarning: string | undefined;

  if (databaseProvider === "postgresql" && !databaseUrl) {
    const prismaPostgresChoice =
      input.prismaPostgres ??
      (useDefaults ? DEFAULT_PRISMA_POSTGRES : await promptForPrismaPostgres());
    if (prismaPostgresChoice === undefined) {
      return;
    }

    shouldUsePrismaPostgres = prismaPostgresChoice;
  }

  const detectedPackageManager = await detectPackageManager();
  const finalPackageManager =
    input.packageManager ??
    (useDefaults
      ? detectedPackageManager
      : await promptForPackageManager(detectedPackageManager));
  if (!finalPackageManager) {
    return;
  }
  const installCommand = getInstallCommand(finalPackageManager);

  if (shouldUsePrismaPostgres) {
    const createDbCommand = getCreateDbCommand(finalPackageManager);
    const prismaPostgresSpinner = spinner();
    prismaPostgresSpinner.start(
      `Provisioning Prisma Postgres with ${createDbCommand}...`
    );

    try {
      const prismaPostgresResult =
        await provisionPrismaPostgres(finalPackageManager);
      databaseUrl = prismaPostgresResult.databaseUrl;
      claimUrl = prismaPostgresResult.claimUrl;
      deletionDate = prismaPostgresResult.deletionDate;
      prismaPostgresSpinner.stop("Prisma Postgres database provisioned.");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      prismaPostgresSpinner.stop("Could not provision Prisma Postgres.");
      prismaPostgresWarning = `Prisma Postgres provisioning failed: ${errorMessage}`;

      const shouldContinue = useDefaults
        ? true
        : await promptContinueWithDefaultPostgresUrl();
      if (shouldContinue === undefined) {
        return;
      }

      if (!shouldContinue) {
        cancel("Cancelled.");
        return;
      }
    }
  }

  await writePrismaDependencies(databaseProvider);

  const shouldInstall =
    input.install ??
    (useDefaults
      ? DEFAULT_INSTALL
      : await promptForDependencyInstall(finalPackageManager));
  if (shouldInstall === undefined) {
    return;
  }

  if (shouldInstall) {
    if (verbose) {
      log.step(`Running ${installCommand}`);
      try {
        await installProjectDependencies(finalPackageManager, process.cwd(), {
          verbose,
        });
        log.success("Dependencies installed.");
      } catch (error) {
        cancel(`Failed to run ${installCommand}: ${getCommandErrorMessage(error)}`);
        return;
      }
    } else {
      const installSpinner = spinner();
      installSpinner.start(`Running ${installCommand}...`);
      try {
        await installProjectDependencies(finalPackageManager, process.cwd(), {
          verbose,
        });
        installSpinner.stop("Dependencies installed.");
      } catch (error) {
        installSpinner.stop("Could not install dependencies.");
        cancel(`Failed to run ${installCommand}: ${getCommandErrorMessage(error)}`);
        return;
      }
    }
  }

  const initSpinner = spinner();
  initSpinner.start("Preparing Prisma files...");
  let initResult: InitPrismaResult;
  try {
    initResult = await initializePrismaFiles({
      provider: databaseProvider,
      databaseUrl,
      claimUrl,
      schemaPreset,
      prismaFilesMode,
    });
  } catch (error) {
    initSpinner.stop("Could not prepare Prisma files.");
    cancel(getCommandErrorMessage(error));
    return;
  }
  if (initResult.prismaFilesMode === "overwrite") {
    initSpinner.stop("Prisma files updated.");
  } else if (initResult.prismaFilesMode === "reuse") {
    initSpinner.stop("Using existing Prisma files.");
  } else {
    initSpinner.stop("Prisma files ready.");
  }

  const generateCommand = getPrismaCliCommand(finalPackageManager, [
    "generate",
  ]);
  let generateWarning: string | undefined;
  let didGenerateClient = false;
  if (shouldGenerate) {
    if (verbose) {
      log.step(`Running ${generateCommand}`);
    }

    const generateSpinner = verbose ? undefined : spinner();
    generateSpinner?.start("Generating Prisma Client...");
    try {
      const generateArgs = getPrismaCliArgs(finalPackageManager, ["generate"]);
      await execa(generateArgs.command, generateArgs.args, {
        cwd: process.cwd(),
        stdio: verbose ? "inherit" : "pipe",
      });
      didGenerateClient = true;
      if (verbose) {
        log.success("Prisma Client generated.");
      } else {
        generateSpinner?.stop("Prisma Client generated.");
      }
    } catch (error) {
      if (verbose) {
        log.warn("Could not generate Prisma Client.");
      } else {
        generateSpinner?.stop("Could not generate Prisma Client.");
      }
      generateWarning = `Prisma generate failed: ${getCommandErrorMessage(error)}`;
    }
  }

  const fileActionLabel = formatFileAction(initResult.prismaFilesMode);
  const summaryLines: string[] = [
    `- ${fileActionLabel} ${formatCreatedPath(initResult.schemaPath)}`,
    `- ${fileActionLabel} ${formatCreatedPath(initResult.configPath)}`,
    `- ${fileActionLabel} ${formatCreatedPath(initResult.singletonPath)}`,
  ];

  if (initResult.envStatus !== "existing") {
    summaryLines.push(
      `- ${formatEnvStatus(initResult.envStatus, initResult.envPath, "DATABASE_URL")}`
    );
  }
  if (initResult.claimEnvStatus) {
    summaryLines.push(
      `- ${formatEnvStatus(initResult.claimEnvStatus, initResult.envPath, "CLAIM_URL")}`
    );
  }
  if (initResult.gitignoreStatus !== "existing") {
    summaryLines.push(
      `- ${formatGitignoreStatus(initResult.gitignoreStatus, initResult.gitignorePath)}`
    );
  }
  if (!shouldInstall) {
    summaryLines.push(`- Skipped ${installCommand}.`);
  }
  if (!shouldGenerate) {
    summaryLines.push("- Skipped Prisma Client generation.");
  }
  summaryLines.push(`- Schema preset: ${schemaPreset}`);

  const postgresLines: string[] = [];
  if (shouldUsePrismaPostgres && !prismaPostgresWarning) {
    postgresLines.push("- Prisma Postgres: provisioned with create-db");
    if (claimUrl) {
      postgresLines.push("- Claim URL saved to CLAIM_URL in .env");
    }
    if (deletionDate) {
      postgresLines.push(
        `- Auto-delete (if unclaimed): ${deletionDate}`
      );
    }
  } else if (prismaPostgresWarning) {
    postgresLines.push(`- ${prismaPostgresWarning}`);
  }
  if (generateWarning) {
    postgresLines.push(`- ${generateWarning}`);
  }

  const nextSteps: string[] = [];
  if (!shouldInstall) {
    nextSteps.push(`- ${installCommand}`);
  }
  if (!didGenerateClient || !shouldGenerate) {
    nextSteps.push(`- ${generateCommand}`);
  }
  nextSteps.push(
    `- ${getPrismaCliCommand(finalPackageManager, ["migrate", "dev"])}`
  );

  outro(`Setup complete.
${summaryLines.join("\n")}
${postgresLines.length > 0 ? `\n${postgresLines.join("\n")}` : ""}

Next steps:
${nextSteps.join("\n")}`);
}
