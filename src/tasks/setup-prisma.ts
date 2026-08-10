import { cancel, confirm, isCancel, log, select, spinner } from "@clack/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import { escapeRegExp } from "../utils/regexp";
import { installProjectDependencies, writePrismaDependencies } from "./install";
import {
  DatabaseProviderSchema,
  PackageManagerSchema,
  type DatabaseProvider,
  type PrismaSetupCommandInput,
  type PackageManager,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
  getPrismaCliArgs,
  getRunScriptArgs,
  getRunScriptCommand,
} from "../utils/package-manager";

type PrismaSetupRunOptions = {
  prependNextSteps?: string[];
  projectDir?: string;
  includeDevNextStep?: boolean;
  includeMigrationAndSeedNextSteps?: boolean;
};

type PrismaGenerateResult = {
  didGenerateClient: boolean;
  warning?: string;
};

type PrismaMigrationGenerationResult = {
  didGenerateMigration: boolean;
  warning?: string;
};

export type PrismaSetupContext = {
  projectDir: string;
  verbose: boolean;
  databaseProvider: DatabaseProvider;
  databaseUrl?: string;
  shouldUsePrismaPostgres: boolean;
  packageManager: PackageManager;
  shouldInstall: boolean;
  shouldMigrateAndSeed: boolean;
};

export type PrismaSetupInitialContext = Omit<
  PrismaSetupContext,
  "shouldUsePrismaPostgres" | "shouldMigrateAndSeed"
>;

type FinalizePrismaOptions = {
  provider: DatabaseProvider;
  projectDir?: string;
};

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgresql";
const DEFAULT_INSTALL = true;
const INITIAL_MIGRATION_NAME = "00000000000000_init";

const requiredPrismaFileGroups = [
  ["prisma/schema.prisma", "packages/db/prisma/schema.prisma"],
  ["prisma/seed.ts", "packages/db/prisma/seed.ts"],
  ["prisma.config.ts", "packages/db/prisma.config.ts"],
  [
    "src/lib/prisma.ts",
    "src/lib/prisma.server.ts",
    "src/lib/server/prisma.ts",
    "server/utils/prisma.ts",
    "packages/db/src/client.ts",
  ],
] as const;

async function resolvePrismaProjectDir(projectDir: string): Promise<string> {
  const monorepoDbDir = path.join(projectDir, "packages/db");
  if (await fs.pathExists(path.join(monorepoDbDir, "prisma/schema.prisma"))) {
    return monorepoDbDir;
  }

  return projectDir;
}

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
  detected: PackageManager,
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
  detectedPackageManager: PackageManager,
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
        value: "yarn",
        label: "yarn",
        hint: getPackageManagerHint("yarn", detectedPackageManager),
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
  packageManager: PackageManager,
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

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    if (stderr.length > 0) {
      return stderr;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

export async function collectPrismaSetupContext(
  input: PrismaSetupCommandInput,
  options: {
    projectDir?: string;
    shouldMigrateAndSeed?: boolean;
  } = {},
): Promise<PrismaSetupContext | undefined> {
  const initialContext = await collectPrismaSetupInitialContext(input, options);
  if (!initialContext) {
    return;
  }

  return completePrismaSetupContext(initialContext, {
    shouldMigrateAndSeed: options.shouldMigrateAndSeed,
  });
}

export async function collectPrismaSetupInitialContext(
  input: PrismaSetupCommandInput,
  options: {
    projectDir?: string;
  } = {},
): Promise<PrismaSetupInitialContext | undefined> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const useDefaults = input.yes === true;
  const verbose = input.verbose === true;

  const databaseProvider =
    input.provider ?? (useDefaults ? DEFAULT_DATABASE_PROVIDER : await promptForDatabaseProvider());
  if (!databaseProvider) {
    return;
  }

  const databaseUrl = (process.env.DATABASE_URL ?? "").trim() || undefined;
  const detectedPackageManager = await detectPackageManager(projectDir);
  const packageManager =
    input.packageManager ??
    (useDefaults ? detectedPackageManager : await promptForPackageManager(detectedPackageManager));
  if (!packageManager) {
    return;
  }

  const shouldInstall =
    input.install ??
    (useDefaults ? DEFAULT_INSTALL : await promptForDependencyInstall(packageManager));
  if (shouldInstall === undefined) {
    return;
  }

  return {
    projectDir,
    verbose,
    databaseProvider,
    databaseUrl,
    packageManager,
    shouldInstall,
  };
}

export async function completePrismaSetupContext(
  context: PrismaSetupInitialContext,
  options: {
    shouldMigrateAndSeed?: boolean;
  } = {},
): Promise<PrismaSetupContext | undefined> {
  const shouldUsePrismaPostgres = context.databaseProvider === "postgresql";

  return {
    ...context,
    shouldUsePrismaPostgres,
    shouldMigrateAndSeed: options.shouldMigrateAndSeed === true,
  };
}

function getDefaultDatabaseUrl(provider: DatabaseProvider): string {
  switch (provider) {
    case "postgresql":
      return "postgresql://johndoe:randompassword@localhost:5432/mydb?schema=public";
    case "cockroachdb":
      return "postgresql://johndoe:randompassword@localhost:26257/mydb?schema=public";
    case "mysql":
      return "mysql://johndoe:randompassword@localhost:3306/mydb";
    case "sqlite":
      return "file:./dev.db";
    case "sqlserver":
      return "sqlserver://localhost:1433;database=mydb;user=SA;password=randompassword;";
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported provider: ${String(exhaustiveCheck)}`);
    }
  }
}

function hasGitignoreEntry(content: string, entry: string): boolean {
  const escapedEntry = escapeRegExp(entry);
  const escapedWithLeadingSlash = escapeRegExp(`/${entry}`);
  const escapedWithTrailingSlash = escapeRegExp(`${entry}/`);
  const escapedWithLeadingAndTrailingSlash = escapeRegExp(`/${entry}/`);
  return new RegExp(
    `(^|\\n)\\s*(?:${escapedEntry}|${escapedWithLeadingSlash}|${escapedWithTrailingSlash}|${escapedWithLeadingAndTrailingSlash})\\s*(?=\\n|$)`,
  ).test(content);
}

async function ensureGitignoreEntry(projectDir: string, entry: string): Promise<void> {
  const gitignorePath = path.join(projectDir, ".gitignore");

  if (!(await fs.pathExists(gitignorePath))) {
    await fs.writeFile(gitignorePath, `${entry}\n`, "utf8");
    return;
  }

  const existingContent = await fs.readFile(gitignorePath, "utf8");
  if (hasGitignoreEntry(existingContent, entry)) {
    return;
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  await fs.appendFile(gitignorePath, `${separator}${entry}\n`, "utf8");
}

async function ensureRequiredPrismaFiles(projectDir: string): Promise<void> {
  const missingFiles: string[] = [];

  for (const candidates of requiredPrismaFileGroups) {
    let foundCandidate = false;

    for (const relativePath of candidates) {
      const absolutePath = path.join(projectDir, relativePath);
      if (await fs.pathExists(absolutePath)) {
        foundCandidate = true;
        break;
      }
    }

    if (!foundCandidate) {
      missingFiles.push(candidates.join(" or "));
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(`Template is missing required Prisma files: ${missingFiles.join(", ")}`);
  }
}

async function finalizePrismaFiles(options: FinalizePrismaOptions): Promise<void> {
  const projectDir = options.projectDir ?? process.cwd();
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);

  await ensureRequiredPrismaFiles(projectDir);
  const generatedDir = (await fs.pathExists(path.join(prismaProjectDir, "server/utils/prisma.ts")))
    ? "server/generated"
    : "src/generated";

  if (options.provider !== "postgresql") {
    const envExamplePath = path.join(prismaProjectDir, ".env.example");
    if (!(await fs.pathExists(envExamplePath))) {
      await fs.writeFile(
        envExamplePath,
        `# Copy this file to .env and replace the value before deploying.\nDATABASE_URL="${getDefaultDatabaseUrl(options.provider)}"\n`,
        "utf8",
      );
    }
  }

  await ensureGitignoreEntry(prismaProjectDir, generatedDir);
}

async function writeDependenciesForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  try {
    await writePrismaDependencies(
      context.databaseProvider,
      context.packageManager,
      prismaProjectDir,
    );
    return true;
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

async function installDependenciesForContext(
  context: PrismaSetupContext,
  projectDir: string,
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

async function finalizePrismaFilesForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  const initSpinner = spinner();
  initSpinner.start("Preparing Prisma files...");

  try {
    await finalizePrismaFiles({
      provider: context.databaseProvider,
      projectDir,
    });

    initSpinner.stop("Prisma files ready.");
    return true;
  } catch (error) {
    initSpinner.stop("Could not prepare Prisma files.");
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

async function generatePrismaClientForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<PrismaGenerateResult> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  const generateCommand = getRunScriptCommand(context.packageManager, "db:generate");
  if (context.verbose) {
    log.step(`Running ${generateCommand}`);
  }

  const generateSpinner = context.verbose ? undefined : spinner();
  generateSpinner?.start("Generating Prisma Client...");
  try {
    const generateArgs = getRunScriptArgs(context.packageManager, "db:generate");
    await execa(generateArgs.command, generateArgs.args, {
      cwd: prismaProjectDir,
      env: {
        ...process.env,
        DATABASE_URL: context.databaseUrl ?? getDefaultDatabaseUrl(context.databaseProvider),
      },
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

async function generateInitialMigrationForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<PrismaMigrationGenerationResult> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  const migrationsDir = path.join(prismaProjectDir, "prisma/migrations");
  if (await fs.pathExists(migrationsDir)) {
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    if (entries.some((entry) => entry.isDirectory())) {
      return { didGenerateMigration: true };
    }
  }

  if (!context.shouldInstall) {
    return { didGenerateMigration: false };
  }

  const migrationDir = path.join(migrationsDir, INITIAL_MIGRATION_NAME);
  const migrationFile = path.join(migrationDir, "migration.sql");
  const migrationInvocation = getPrismaCliArgs(context.packageManager, [
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema",
    "prisma/schema.prisma",
    "--script",
    "--output",
    migrationFile,
  ]);
  const migrationSpinner = context.verbose ? undefined : spinner();
  migrationSpinner?.start("Generating initial migration...");

  try {
    await fs.ensureDir(migrationDir);
    await execa(migrationInvocation.command, migrationInvocation.args, {
      cwd: prismaProjectDir,
      env: {
        ...process.env,
        DATABASE_URL: context.databaseUrl ?? getDefaultDatabaseUrl(context.databaseProvider),
      },
      stdio: context.verbose ? "inherit" : "pipe",
    });
    await fs.writeFile(
      path.join(migrationsDir, "migration_lock.toml"),
      `# Please do not edit this file manually\nprovider = "${context.databaseProvider}"\n`,
      "utf8",
    );
    if (context.verbose) {
      log.success("Initial migration generated.");
    } else {
      migrationSpinner?.stop("Initial migration generated.");
    }
    return { didGenerateMigration: true };
  } catch (error) {
    await fs.remove(migrationDir);
    if (context.verbose) {
      log.warn("Could not generate the initial migration.");
    } else {
      migrationSpinner?.stop("Could not generate the initial migration.");
    }
    return {
      didGenerateMigration: false,
      warning: `Initial migration generation failed: ${getCommandErrorMessage(error)}`,
    };
  }
}

function buildWarningLines(
  generateWarning: string | undefined,
  migrationGenerationWarning: string | undefined,
  migrateAndSeedWarning?: string,
): string[] {
  const warningLines: string[] = [];

  if (generateWarning) {
    warningLines.push(`- ${generateWarning}`);
  }
  if (migrationGenerationWarning) {
    warningLines.push(`- ${migrationGenerationWarning}`);
  }
  if (migrateAndSeedWarning) {
    warningLines.push(`- ${migrateAndSeedWarning}`);
  }

  return warningLines;
}

function buildNextStepsForContext(opts: {
  context: PrismaSetupContext;
  options: PrismaSetupRunOptions;
  didGenerateClient: boolean;
  didMigrate: boolean;
  didSeed: boolean;
}): string[] {
  const { context, options, didGenerateClient, didMigrate, didSeed } = opts;
  const nextSteps: string[] = [...(options.prependNextSteps ?? [])];

  if (!context.shouldInstall) {
    nextSteps.push(`- ${getInstallCommand(context.packageManager)}`);
  }
  if (!didGenerateClient) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:generate")}`);
  }
  if (options.includeMigrationAndSeedNextSteps !== false && !didMigrate) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:migrate")}`);
  }
  if (options.includeMigrationAndSeedNextSteps !== false && !didSeed) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:seed")}`);
  }
  if (options.includeDevNextStep) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "dev")}`);
  }

  return nextSteps;
}

export type PrismaSetupResult =
  | { ok: false }
  | {
      ok: true;
      nextSteps: string[];
      warningSection: string;
      didGenerateClient: boolean;
      didGenerateMigration: boolean;
    };

export async function executePrismaSetupContext(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
): Promise<PrismaSetupResult> {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const didWriteDependencies = await writeDependenciesForContext(context, projectDir);
  if (!didWriteDependencies) {
    return { ok: false };
  }

  const dependenciesInstalled = await installDependenciesForContext(context, projectDir);
  if (!dependenciesInstalled) {
    return { ok: false };
  }

  const didFinalizePrismaFiles = await finalizePrismaFilesForContext(context, projectDir);
  if (!didFinalizePrismaFiles) {
    return { ok: false };
  }

  const generateResult = await generatePrismaClientForContext(context, projectDir);
  const migrationGenerationResult = await generateInitialMigrationForContext(context, projectDir);

  const migrateAndSeedResult = await migrateAndSeedIfRequested(context, projectDir, {
    databaseUrl: context.databaseUrl,
    didGenerateClient: generateResult.didGenerateClient,
  });

  const warningLines = buildWarningLines(
    generateResult.warning,
    migrationGenerationResult.warning,
    migrateAndSeedResult.warning,
  );
  const nextSteps = buildNextStepsForContext({
    context,
    options,
    didGenerateClient: generateResult.didGenerateClient,
    didMigrate: migrateAndSeedResult.didMigrate,
    didSeed: migrateAndSeedResult.didSeed,
  });

  const warningSection = warningLines.length > 0 ? `\n\n${warningLines.join("\n")}` : "";

  return {
    ok: true,
    nextSteps,
    warningSection,
    didGenerateClient: generateResult.didGenerateClient,
    didGenerateMigration: migrationGenerationResult.didGenerateMigration,
  };
}

async function migrateAndSeedIfRequested(
  context: PrismaSetupContext,
  projectDir: string,
  options: { databaseUrl?: string; didGenerateClient: boolean },
): Promise<{ didMigrate: boolean; didSeed: boolean; warning?: string }> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);

  if (!context.shouldMigrateAndSeed) {
    return { didMigrate: false, didSeed: false };
  }
  if (!options.didGenerateClient) {
    return {
      didMigrate: false,
      didSeed: false,
      warning: "Skipped migrate + seed because the Prisma Client was not generated.",
    };
  }
  if (!options.databaseUrl) {
    return {
      didMigrate: false,
      didSeed: false,
      warning: "Skipped migrate + seed because no DATABASE_URL is available.",
    };
  }

  const migrateInvocation = getPrismaCliArgs(context.packageManager, ["migrate", "deploy"]);
  const seedInvocation = getPrismaCliArgs(context.packageManager, ["db", "seed"]);

  const migrateSpinner = spinner();
  migrateSpinner.start("Applying migrations...");
  let didMigrate = false;
  try {
    await execa(migrateInvocation.command, migrateInvocation.args, {
      cwd: prismaProjectDir,
      env: { ...process.env, DATABASE_URL: options.databaseUrl },
      stdio: context.verbose ? "inherit" : "pipe",
    });
    migrateSpinner.stop("Migrations applied.");
    didMigrate = true;
  } catch (error) {
    migrateSpinner.stop(`Migration failed${error instanceof Error ? `: ${error.message}` : "."}`);
    return {
      didMigrate: false,
      didSeed: false,
      warning: `Migration failed; run \`${getRunScriptCommand(context.packageManager, "db:migrate:deploy")}\` manually.`,
    };
  }

  const seedSpinner = spinner();
  seedSpinner.start("Seeding database...");
  let didSeed = false;
  try {
    await execa(seedInvocation.command, seedInvocation.args, {
      cwd: prismaProjectDir,
      env: { ...process.env, DATABASE_URL: options.databaseUrl },
      stdio: context.verbose ? "inherit" : "pipe",
    });
    seedSpinner.stop("Database seeded.");
    didSeed = true;
  } catch (error) {
    seedSpinner.stop(`Seed failed${error instanceof Error ? `: ${error.message}` : "."}`);
    return {
      didMigrate,
      didSeed: false,
      warning: `Seed failed; run \`${getRunScriptCommand(context.packageManager, "db:seed")}\` manually.`,
    };
  }

  return { didMigrate, didSeed };
}
