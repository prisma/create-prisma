import {
  cancel,
  confirm,
  isCancel,
  log,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import {
  installProjectDependencies,
  writePrismaDependencies,
} from "./install";
import {
  getCreateDbCommand,
  PRISMA_POSTGRES_TEMPORARY_NOTICE,
  provisionPrismaPostgres,
} from "./prisma-postgres";
import {
  DatabaseProviderSchema,
  PackageManagerSchema,
  type DatabaseProvider,
  type DependencyWriteResult,
  type EnvStatus,
  type FileAppendStatus,
  type FinalizePrismaOptions,
  type FinalizePrismaResult,
  type PrismaGenerateResult,
  type PrismaPostgresProvisionResult,
  type PrismaSetupCommandInput,
  type PrismaSetupContext,
  type PrismaSetupResult,
  type PrismaSetupRunOptions,
  type PackageManager,
  type SchemaPreset,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
  getPrismaCliArgs,
  getPrismaCliCommand,
  getRunScriptCommand,
} from "../utils/package-manager";

type EnvWriteMode = "keep-existing" | "upsert";

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgresql";
const DEFAULT_SCHEMA_PRESET: SchemaPreset = "empty";
const DEFAULT_PRISMA_POSTGRES = true;
const DEFAULT_INSTALL = true;
const DEFAULT_GENERATE = true;

const requiredPrismaFileGroups = [
  ["prisma/schema.prisma", "packages/db/prisma/schema.prisma"],
  ["prisma/seed.ts", "packages/db/prisma/seed.ts"],
  ["prisma.config.ts", "packages/db/prisma.config.ts"],
  [
    "src/lib/prisma.ts",
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
    defaultSchemaPreset?: SchemaPreset;
  } = {}
): Promise<PrismaSetupContext | undefined> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const useDefaults = input.yes === true;
  const verbose = input.verbose === true;
  const shouldGenerate = input.generate ?? DEFAULT_GENERATE;

  const databaseProvider =
    input.provider ??
    (useDefaults ? DEFAULT_DATABASE_PROVIDER : await promptForDatabaseProvider());
  if (!databaseProvider) {
    return;
  }

  const schemaPreset =
    input.schemaPreset ?? options.defaultSchemaPreset ?? DEFAULT_SCHEMA_PRESET;

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
    databaseProvider,
    schemaPreset,
    databaseUrl,
    shouldUsePrismaPostgres,
    packageManager,
    shouldInstall,
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

// Escape regex metacharacters before interpolating dynamic values into RegExp.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("Environment variable values must be single-line.");
  }

  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function hasEnvVar(content: string, envVarName: string): boolean {
  const escapedName = escapeRegExp(envVarName);
  return new RegExp(`(^|\\n)\\s*${escapedName}\\s*=`).test(content);
}

function hasEnvComment(content: string, comment: string): boolean {
  const escapedComment = escapeRegExp(comment);
  return new RegExp(`(^|\\n)\\s*#\\s*${escapedComment}\\s*(?=\\n|$)`).test(
    content
  );
}

async function ensureEnvVarInEnv(
  projectDir: string,
  envVarName: string,
  envVarValue: string,
  opts: {
    mode: EnvWriteMode;
    comment?: string;
  }
): Promise<{ envPath: string; status: EnvStatus }> {
  const envPath = path.join(projectDir, ".env");
  const envLine = `${envVarName}="${escapeEnvValue(envVarValue)}"`;

  if (!(await fs.pathExists(envPath))) {
    const content = opts.comment
      ? `# ${opts.comment}\n${envLine}\n`
      : `${envLine}\n`;
    await fs.writeFile(envPath, content, "utf8");
    return { envPath, status: "created" };
  }

  const existingContent = await fs.readFile(envPath, "utf8");
  if (hasEnvVar(existingContent, envVarName)) {
    if (opts.mode === "keep-existing") {
      return { envPath, status: "existing" };
    }

    const escapedName = escapeRegExp(envVarName);
    const lineRegex = new RegExp(
      `(^|\\n)\\s*${escapedName}\\s*=.*(?=\\n|$)`,
      "gm"
    );
    const updatedContent = existingContent.replace(lineRegex, `$1${envLine}`);
    if (updatedContent === existingContent) {
      return { envPath, status: "existing" };
    }

    await fs.writeFile(envPath, updatedContent, "utf8");
    return { envPath, status: "updated" };
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  const commentLine = opts.comment ? `\n# ${opts.comment}\n` : "\n";
  const insertion = `${separator}${commentLine}${envLine}\n`;
  await fs.appendFile(envPath, insertion, "utf8");

  return { envPath, status: "appended" };
}

async function ensureEnvComment(
  projectDir: string,
  comment: string
): Promise<void> {
  const envPath = path.join(projectDir, ".env");
  const commentLine = `# ${comment}`;

  if (!(await fs.pathExists(envPath))) {
    await fs.writeFile(envPath, `${commentLine}\n`, "utf8");
    return;
  }

  const existingContent = await fs.readFile(envPath, "utf8");
  if (hasEnvComment(existingContent, comment)) {
    return;
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  await fs.appendFile(envPath, `${separator}${commentLine}\n`, "utf8");
}

function hasGitignoreEntry(content: string, entry: string): boolean {
  const escapedEntry = escapeRegExp(entry);
  const escapedWithLeadingSlash = escapeRegExp(`/${entry}`);
  const escapedWithTrailingSlash = escapeRegExp(`${entry}/`);
  const escapedWithLeadingAndTrailingSlash = escapeRegExp(`/${entry}/`);
  return new RegExp(
    `(^|\\n)\\s*(?:${escapedEntry}|${escapedWithLeadingSlash}|${escapedWithTrailingSlash}|${escapedWithLeadingAndTrailingSlash})\\s*(?=\\n|$)`
  ).test(content);
}

async function ensureGitignoreEntry(
  projectDir: string,
  entry: string
): Promise<{ gitignorePath: string; status: FileAppendStatus }> {
  const gitignorePath = path.join(projectDir, ".gitignore");

  if (!(await fs.pathExists(gitignorePath))) {
    await fs.writeFile(gitignorePath, `${entry}\n`, "utf8");
    return { gitignorePath, status: "created" };
  }

  const existingContent = await fs.readFile(gitignorePath, "utf8");
  if (hasGitignoreEntry(existingContent, entry)) {
    return { gitignorePath, status: "existing" };
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  await fs.appendFile(gitignorePath, `${separator}${entry}\n`, "utf8");
  return { gitignorePath, status: "appended" };
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
    throw new Error(
      `Template is missing required Prisma files: ${missingFiles.join(", ")}`
    );
  }
}

async function finalizePrismaFiles(
  options: FinalizePrismaOptions
): Promise<FinalizePrismaResult> {
  const projectDir = options.projectDir ?? process.cwd();
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  const schemaPath = path.join(prismaProjectDir, "prisma/schema.prisma");
  const configPath = path.join(prismaProjectDir, "prisma.config.ts");

  await ensureRequiredPrismaFiles(projectDir);
  const singletonPath = (await fs.pathExists(path.join(prismaProjectDir, "src/lib/prisma.ts")))
    ? path.join(prismaProjectDir, "src/lib/prisma.ts")
    : (await fs.pathExists(path.join(prismaProjectDir, "src/lib/server/prisma.ts")))
      ? path.join(prismaProjectDir, "src/lib/server/prisma.ts")
      : (await fs.pathExists(path.join(prismaProjectDir, "server/utils/prisma.ts")))
        ? path.join(prismaProjectDir, "server/utils/prisma.ts")
        : path.join(prismaProjectDir, "src/client.ts");
  const generatedDir = (await fs.pathExists(path.join(prismaProjectDir, "server/utils/prisma.ts")))
    ? "server/generated"
    : "src/generated";

  const databaseUrl =
    options.databaseUrl ?? getDefaultDatabaseUrl(options.provider);
  const envResult = await ensureEnvVarInEnv(
    prismaProjectDir,
    "DATABASE_URL",
    databaseUrl,
    {
      mode: options.databaseUrl ? "upsert" : "keep-existing",
      comment: "Added by create-prisma",
    }
  );

  let claimEnvStatus: EnvStatus | undefined;
  if (options.claimUrl) {
    const claimResult = await ensureEnvVarInEnv(
      prismaProjectDir,
      "CLAIM_URL",
      options.claimUrl,
      {
        mode: "upsert",
        comment: PRISMA_POSTGRES_TEMPORARY_NOTICE,
      }
    );
    claimEnvStatus = claimResult.status;
    await ensureEnvComment(prismaProjectDir, PRISMA_POSTGRES_TEMPORARY_NOTICE);
  }

  const gitignoreResult = await ensureGitignoreEntry(prismaProjectDir, generatedDir);

  return {
    schemaPath,
    configPath,
    singletonPath,
    envPath: envResult.envPath,
    envStatus: envResult.status,
    gitignorePath: gitignoreResult.gitignorePath,
    gitignoreStatus: gitignoreResult.status,
    claimEnvStatus,
  };
}

async function provisionPrismaPostgresIfNeeded(
  context: PrismaSetupContext,
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
  context: PrismaSetupContext,
  projectDir: string
): Promise<DependencyWriteResult | undefined> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  try {
    return await writePrismaDependencies(
      context.databaseProvider,
      prismaProjectDir
    );
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return;
  }
}

async function installDependenciesForContext(
  context: PrismaSetupContext,
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

async function finalizePrismaFilesForContext(
  context: PrismaSetupContext,
  projectDir: string,
  provisionResult: PrismaPostgresProvisionResult
): Promise<FinalizePrismaResult | undefined> {
  const initSpinner = spinner();
  initSpinner.start("Preparing Prisma files...");

  try {
    const finalizeResult = await finalizePrismaFiles({
      provider: context.databaseProvider,
      databaseUrl: provisionResult.databaseUrl,
      claimUrl: provisionResult.claimUrl,
      projectDir,
    });

    initSpinner.stop("Prisma files ready.");
    return finalizeResult;
  } catch (error) {
    initSpinner.stop("Could not prepare Prisma files.");
    cancel(getCommandErrorMessage(error));
    return;
  }
}

async function generatePrismaClientForContext(
  context: PrismaSetupContext,
  projectDir: string
): Promise<PrismaGenerateResult> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
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
      cwd: prismaProjectDir,
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
  context: PrismaSetupContext;
  options: PrismaSetupRunOptions;
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
  nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:seed")}`);
  if (options.includeDevNextStep) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "dev")}`);
  }

  return nextSteps;
}

export async function executePrismaSetupContext(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {}
): Promise<PrismaSetupResult | undefined> {
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

  const finalizeResult = await finalizePrismaFilesForContext(
    context,
    projectDir,
    provisionResult
  );
  if (!finalizeResult) {
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
