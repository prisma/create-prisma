import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import path from "node:path";

import { initializePrismaFiles } from "../tasks/init-prisma";
import {
  installProjectDependencies,
  writePrismaDependencies,
} from "../tasks/install";
import {
  getCreateDbCommandString,
  provisionPrismaPostgres,
  type PrismaPostgresResult,
} from "../tasks/prisma-postgres";
import {
  DatabaseProviderSchema,
  InitCommandInputSchema,
  PackageManagerSchema,
  type DatabaseProvider,
  type InitCommandInput,
  type PackageManager,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
} from "../utils/package-manager";

async function promptForDatabaseProvider(): Promise<DatabaseProvider | undefined> {
  const databaseProvider = await select({
    message: "Select your database",
    initialValue: "postgresql",
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

function getPrismaCommand(packageManager: PackageManager, args: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm dlx prisma ${args}`;
    case "bun":
      return `bunx --bun prisma ${args}`;
    case "npm":
    default:
      return `npx prisma ${args}`;
  }
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

async function promptForPrismaPostgres(
): Promise<boolean | undefined> {
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

function formatCreatedPath(filePath: string): string {
  return path.relative(process.cwd(), filePath);
}

export async function runInitCommand(rawInput: InitCommandInput = {}): Promise<void> {
  const input = InitCommandInputSchema.parse(rawInput);

  intro("Create Prisma");

  const databaseProvider = input.provider ?? (await promptForDatabaseProvider());
  if (!databaseProvider) {
    return;
  }

  let databaseUrl = input.databaseUrl;
  let shouldUsePrismaPostgres = false;
  let prismaPostgresResult: PrismaPostgresResult | undefined;
  let prismaPostgresWarning: string | undefined;

  if (databaseProvider === "postgresql" && !databaseUrl) {
    const prismaPostgresChoice =
      input.prismaPostgres ?? (await promptForPrismaPostgres());
    if (prismaPostgresChoice === undefined) {
      return;
    }

    shouldUsePrismaPostgres = prismaPostgresChoice;
  }

  const packageManager =
    input.packageManager ??
    (await promptForPackageManager(await detectPackageManager()));
  if (!packageManager) {
    return;
  }
  const installCommand = getInstallCommand(packageManager);

  if (shouldUsePrismaPostgres) {
    const createDbCommand = getCreateDbCommandString(packageManager);
    const prismaPostgresSpinner = spinner();
    prismaPostgresSpinner.start(
      `Provisioning Prisma Postgres with ${createDbCommand}...`
    );

    try {
      prismaPostgresResult = await provisionPrismaPostgres(packageManager);
      databaseUrl = prismaPostgresResult.databaseUrl;
      prismaPostgresSpinner.stop("Prisma Postgres database provisioned.");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      prismaPostgresSpinner.stop("Could not provision Prisma Postgres.");
      prismaPostgresWarning = `Prisma Postgres provisioning failed: ${errorMessage}`;

      const shouldContinue =
        await promptContinueWithDefaultPostgresUrl();
      if (shouldContinue === undefined) {
        return;
      }

      if (!shouldContinue) {
        cancel("Cancelled.");
        return;
      }
    }
  }

  const dependencySpinner = spinner();
  dependencySpinner.start("Updating package.json...");
  await writePrismaDependencies(databaseProvider);
  dependencySpinner.stop("Updated package.json.");

  const shouldInstall =
    input.install ?? (await promptForDependencyInstall(packageManager));
  if (shouldInstall === undefined) {
    return;
  }

  let installStatus = `Skipped ${installCommand}.`;
  if (shouldInstall) {
    const installSpinner = spinner();
    installSpinner.start(`Running ${installCommand}...`);
    await installProjectDependencies(packageManager);
    installSpinner.stop("Dependencies installed.");
    installStatus = `Installed dependencies with ${installCommand}.`;
  }

  const initSpinner = spinner();
  initSpinner.start("Scaffolding Prisma files...");
  const initResult = await initializePrismaFiles({
    provider: databaseProvider,
    databaseUrl,
    claimUrl: prismaPostgresResult?.claimUrl,
  });
  initSpinner.stop("Prisma files ready.");

  const summaryLines: string[] = [
    `- Created ${formatCreatedPath(initResult.schemaPath)}`,
    `- Created ${formatCreatedPath(initResult.configPath)}`,
    `- Created ${formatCreatedPath(initResult.singletonPath)}`,
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
  if (!shouldInstall) {
    summaryLines.push(`- ${installStatus}`);
  }

  const postgresLines: string[] = [];
  if (prismaPostgresResult) {
    postgresLines.push("- Prisma Postgres: provisioned with create-db");
    if (prismaPostgresResult.claimUrl) {
      postgresLines.push("- Claim URL saved to CLAIM_URL in .env");
    }
    if (prismaPostgresResult.deletionDate) {
      postgresLines.push(
        `- Auto-delete (if unclaimed): ${prismaPostgresResult.deletionDate}`
      );
    }
  } else if (prismaPostgresWarning) {
    postgresLines.push(`- ${prismaPostgresWarning}`);
  }

  const nextSteps: string[] = [];
  if (!shouldInstall) {
    nextSteps.push(`- ${installCommand}`);
  }
  nextSteps.push(`- ${getPrismaCommand(packageManager, "generate")}`);
  nextSteps.push(`- ${getPrismaCommand(packageManager, "migrate dev")}`);

  outro(`Setup complete.
${summaryLines.join("\n")}
${postgresLines.length > 0 ? `\n${postgresLines.join("\n")}` : ""}

Next steps:
${nextSteps.join("\n")}`);
}
