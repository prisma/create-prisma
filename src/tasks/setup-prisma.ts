import { cancel, confirm, isCancel, log, outro, select, spinner } from "@clack/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import { installProjectDependencies, writePrismaDependencies } from "./install";
import {
  getCreateDbCommand,
  PRISMA_POSTGRES_TEMPORARY_NOTICE,
  provisionPrismaPostgres,
} from "./prisma-postgres";
import { dependencyVersionMap } from "../constants/dependencies";
import {
  AuthoringStyleSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
  type AuthoringStyle,
  type DatabaseProvider,
  type PackageManager,
  type PrismaSetupCommandInput,
  type SchemaPreset,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
  getPackageExecutionArgs,
  getPackageExecutionCommand,
  getRunScriptCommand,
} from "../utils/package-manager";

type EnvWriteMode = "keep-existing" | "upsert";

type PrismaSetupRunOptions = {
  prependNextSteps?: string[];
  projectDir?: string;
  includeDevNextStep?: boolean;
};

type PrismaPostgresProvisionResult = {
  databaseUrl?: string;
  claimUrl?: string;
  warning?: string;
};

type PrismaNextEmitResult = {
  didEmitContract: boolean;
  warning?: string;
};

export type PrismaSetupContext = {
  projectDir: string;
  verbose: boolean;
  shouldEmit: boolean;
  databaseProvider: DatabaseProvider;
  authoring: AuthoringStyle;
  schemaPreset: SchemaPreset;
  databaseUrl?: string;
  shouldUsePrismaPostgres: boolean;
  packageManager: PackageManager;
  shouldInstall: boolean;
};

type FinalizePrismaOptions = {
  provider: DatabaseProvider;
  databaseUrl?: string;
  claimUrl?: string;
  projectDir?: string;
};

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgres";
const DEFAULT_AUTHORING: AuthoringStyle = "psl";
const DEFAULT_SCHEMA_PRESET: SchemaPreset = "basic";
const DEFAULT_INSTALL = true;
const DEFAULT_EMIT = true;
const MONGO_DOCKER_COMPOSE = `services:
  mongodb:
    image: mongo:latest
    command: ["mongod", "--replSet", "rs0", "--bind_ip_all"]
    ports:
      - "27017:27017"
    volumes:
      - mongodb-data:/data/db
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "mongosh --quiet --eval 'try { rs.status().members.some((member) => member.stateStr === \\"PRIMARY\\") } catch (error) { rs.initiate({_id: \\"rs0\\", members: [{ _id: 0, host: \\"localhost:27017\\" }] }); false }' | grep true",
        ]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 5s

volumes:
  mongodb-data:
`;

const mongoDockerScripts = {
  "db:up": "docker compose up -d --wait",
  "db:down": "docker compose down",
} as const;

const requiredPrismaFileGroups = [
  [
    "prisma/contract.prisma",
    "prisma/contract.ts",
    "packages/db/prisma/contract.prisma",
    "packages/db/prisma/contract.ts",
  ],
  ["prisma-next.config.ts", "packages/db/prisma-next.config.ts"],
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
  if (
    (await fs.pathExists(path.join(monorepoDbDir, "prisma/contract.prisma"))) ||
    (await fs.pathExists(path.join(monorepoDbDir, "prisma/contract.ts")))
  ) {
    return monorepoDbDir;
  }

  return projectDir;
}

async function promptForDatabaseProvider(): Promise<DatabaseProvider | undefined> {
  const databaseProvider = await select({
    message: "Select your database",
    initialValue: DEFAULT_DATABASE_PROVIDER,
    options: [
      { value: "postgres", label: "PostgreSQL", hint: "Default" },
      { value: "mongo", label: "MongoDB" },
    ],
  });

  if (isCancel(databaseProvider)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return DatabaseProviderSchema.parse(databaseProvider);
}

async function promptForAuthoringStyle(): Promise<AuthoringStyle | undefined> {
  const authoring = await select({
    message: "Choose contract authoring style",
    initialValue: DEFAULT_AUTHORING,
    options: [
      { value: "psl", label: "PSL", hint: "Write prisma/contract.prisma, default" },
      { value: "typescript", label: "TypeScript", hint: "Write prisma/contract.ts with builders" },
    ],
  });

  if (isCancel(authoring)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return AuthoringStyleSchema.parse(authoring);
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

  if (option === "deno") {
    return "Runtime + package manager";
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
      {
        value: "deno",
        label: "deno",
        hint: getPackageManagerHint("deno", detectedPackageManager),
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
    defaultSchemaPreset?: SchemaPreset;
  } = {},
): Promise<PrismaSetupContext | undefined> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const useDefaults = input.yes === true;
  const verbose = input.verbose === true;
  const shouldEmit = input.emit ?? DEFAULT_EMIT;

  const databaseProvider =
    input.provider ?? (useDefaults ? DEFAULT_DATABASE_PROVIDER : await promptForDatabaseProvider());
  if (!databaseProvider) {
    return;
  }

  const authoring =
    input.authoring ?? (useDefaults ? DEFAULT_AUTHORING : await promptForAuthoringStyle());
  if (!authoring) {
    return;
  }

  const schemaPreset = input.schemaPreset ?? options.defaultSchemaPreset ?? DEFAULT_SCHEMA_PRESET;
  const databaseUrl = input.databaseUrl;
  const shouldUsePrismaPostgres = input.prismaPostgres === true;

  if (shouldUsePrismaPostgres && databaseProvider !== "postgres") {
    cancel("--prisma-postgres is only supported with --provider postgres.");
    return;
  }
  if (shouldUsePrismaPostgres && databaseUrl) {
    cancel("Use either --database-url or --prisma-postgres, not both.");
    return;
  }

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
    shouldEmit,
    databaseProvider,
    authoring,
    schemaPreset,
    databaseUrl,
    shouldUsePrismaPostgres,
    packageManager,
    shouldInstall,
  };
}

function getDefaultDatabaseUrl(provider: DatabaseProvider): string {
  switch (provider) {
    case "postgres":
      return "postgresql://user:password@localhost:5432/mydb";
    case "mongo":
      return "mongodb://localhost:27017/mydb?replicaSet=rs0&directConnection=true";
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported Prisma Next target: ${String(exhaustiveCheck)}`);
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
  return new RegExp(`(^|\\n)\\s*#\\s*${escapedComment}\\s*(?=\\n|$)`).test(content);
}

async function ensureEnvVarInEnv(
  projectDir: string,
  envVarName: string,
  envVarValue: string,
  opts: {
    mode: EnvWriteMode;
    comment?: string;
  },
): Promise<void> {
  const envPath = path.join(projectDir, ".env");
  const envLine = `${envVarName}="${escapeEnvValue(envVarValue)}"`;

  if (!(await fs.pathExists(envPath))) {
    const content = opts.comment ? `# ${opts.comment}\n${envLine}\n` : `${envLine}\n`;
    await fs.writeFile(envPath, content, "utf8");
    return;
  }

  const existingContent = await fs.readFile(envPath, "utf8");
  if (hasEnvVar(existingContent, envVarName)) {
    if (opts.mode === "keep-existing") {
      return;
    }

    const escapedName = escapeRegExp(envVarName);
    const lineRegex = new RegExp(`(^|\\n)\\s*${escapedName}\\s*=.*(?=\\n|$)`, "gm");
    const updatedContent = existingContent.replace(lineRegex, `$1${envLine}`);
    if (updatedContent === existingContent) {
      return;
    }

    await fs.writeFile(envPath, updatedContent, "utf8");
    return;
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  const commentLine = opts.comment ? `\n# ${opts.comment}\n` : "\n";
  const insertion = `${separator}${commentLine}${envLine}\n`;
  await fs.appendFile(envPath, insertion, "utf8");
}

async function ensureEnvComment(projectDir: string, comment: string): Promise<void> {
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

async function ensurePackageScripts(
  projectDir: string,
  scripts: Record<string, string>,
): Promise<void> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return;
  }

  const packageJson = await fs.readJson(packageJsonPath);
  if (!packageJson.scripts) {
    packageJson.scripts = {};
  }

  let didChange = false;
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (
      typeof packageJson.scripts[scriptName] !== "string" ||
      packageJson.scripts[scriptName].trim().length === 0
    ) {
      packageJson.scripts[scriptName] = command;
      didChange = true;
    }
  }

  if (didChange) {
    await fs.writeJson(packageJsonPath, packageJson, {
      spaces: 2,
    });
  }
}

async function ensureMongoDockerCompose(projectDir: string): Promise<void> {
  const composePath = path.join(projectDir, "docker-compose.yml");
  if (await fs.pathExists(composePath)) {
    return;
  }

  await fs.writeFile(composePath, MONGO_DOCKER_COMPOSE, "utf8");
}

async function writeMongoDockerHelpersForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  if (context.databaseProvider !== "mongo" || context.databaseUrl) {
    return true;
  }

  try {
    await ensureMongoDockerCompose(projectDir);
    await ensurePackageScripts(projectDir, mongoDockerScripts);
    return true;
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return false;
  }
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
    throw new Error(`Template is missing required Prisma Next files: ${missingFiles.join(", ")}`);
  }
}

async function finalizePrismaFiles(options: FinalizePrismaOptions): Promise<void> {
  const projectDir = options.projectDir ?? process.cwd();
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);

  await ensureRequiredPrismaFiles(projectDir);

  const databaseUrl = options.databaseUrl ?? getDefaultDatabaseUrl(options.provider);
  await ensureEnvVarInEnv(prismaProjectDir, "DATABASE_URL", databaseUrl, {
    mode: options.databaseUrl ? "upsert" : "keep-existing",
    comment: "Added by create-prisma",
  });

  if (options.claimUrl) {
    await ensureEnvVarInEnv(prismaProjectDir, "CLAIM_URL", options.claimUrl, {
      mode: "upsert",
      comment: PRISMA_POSTGRES_TEMPORARY_NOTICE,
    });
    await ensureEnvComment(prismaProjectDir, PRISMA_POSTGRES_TEMPORARY_NOTICE);
  }

  await ensureGitignoreEntry(prismaProjectDir, ".env");
}

async function provisionPrismaPostgresIfNeeded(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<PrismaPostgresProvisionResult | undefined> {
  if (!context.shouldUsePrismaPostgres) {
    return {
      databaseUrl: context.databaseUrl,
    };
  }

  const createDbCommand = getCreateDbCommand(context.packageManager);
  const prismaPostgresSpinner = spinner();
  prismaPostgresSpinner.start(`Provisioning Prisma Postgres with ${createDbCommand}...`);

  try {
    const prismaPostgresResult = await provisionPrismaPostgres(context.packageManager, projectDir);

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
  projectDir: string,
): Promise<boolean> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  try {
    await writePrismaDependencies(
      context.databaseProvider,
      context.packageManager,
      context.authoring,
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
  provisionResult: PrismaPostgresProvisionResult,
): Promise<boolean> {
  const initSpinner = spinner();
  initSpinner.start("Preparing Prisma Next files...");

  try {
    await finalizePrismaFiles({
      provider: context.databaseProvider,
      databaseUrl: provisionResult.databaseUrl,
      claimUrl: provisionResult.claimUrl,
      projectDir,
    });

    initSpinner.stop("Prisma Next files ready.");
    return true;
  } catch (error) {
    initSpinner.stop("Could not prepare Prisma Next files.");
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

function getPrismaNextCliCommand(packageManager: PackageManager, prismaNextArgs: string[]): string {
  return getPackageExecutionCommand(packageManager, [
    `prisma-next@${dependencyVersionMap["prisma-next"]}`,
    ...prismaNextArgs,
  ]);
}

function getPrismaNextCliArgs(
  packageManager: PackageManager,
  prismaNextArgs: string[],
): { command: string; args: string[] } {
  return getPackageExecutionArgs(packageManager, [
    `prisma-next@${dependencyVersionMap["prisma-next"]}`,
    ...prismaNextArgs,
  ]);
}

async function emitPrismaNextContractForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<PrismaNextEmitResult> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  if (!context.shouldEmit) {
    return {
      didEmitContract: false,
    };
  }
  if (!context.shouldInstall) {
    return {
      didEmitContract: false,
      warning: "Skipped contract emit because dependencies were not installed.",
    };
  }

  const emitCommand = getPrismaNextCliCommand(context.packageManager, ["contract", "emit"]);
  if (context.verbose) {
    log.step(`Running ${emitCommand}`);
  }

  const emitSpinner = context.verbose ? undefined : spinner();
  emitSpinner?.start("Emitting Prisma Next contract...");
  try {
    const emitArgs = getPrismaNextCliArgs(context.packageManager, ["contract", "emit"]);
    await execa(emitArgs.command, emitArgs.args, {
      cwd: prismaProjectDir,
      stdio: context.verbose ? "inherit" : "pipe",
    });
    if (context.verbose) {
      log.success("Prisma Next contract emitted.");
    } else {
      emitSpinner?.stop("Prisma Next contract emitted.");
    }

    return {
      didEmitContract: true,
    };
  } catch (error) {
    if (context.verbose) {
      log.warn("Could not emit Prisma Next contract.");
    } else {
      emitSpinner?.stop("Could not emit Prisma Next contract.");
    }

    return {
      didEmitContract: false,
      warning: `Contract emit failed: ${getCommandErrorMessage(error)}`,
    };
  }
}

function buildWarningLines(
  provisionWarning: string | undefined,
  emitWarning: string | undefined,
): string[] {
  const warningLines: string[] = [];

  if (provisionWarning) {
    warningLines.push(`- ${provisionWarning}`);
  }
  if (emitWarning) {
    warningLines.push(`- ${emitWarning}`);
  }

  return warningLines;
}

function buildNextStepsForContext(opts: {
  context: PrismaSetupContext;
  options: PrismaSetupRunOptions;
  didEmitContract: boolean;
}): string[] {
  const { context, options, didEmitContract } = opts;
  const nextSteps: string[] = [...(options.prependNextSteps ?? [])];

  if (!context.shouldInstall) {
    nextSteps.push(`- ${getInstallCommand(context.packageManager)}`);
  }
  if (!didEmitContract || !context.shouldEmit) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "contract:emit")}`);
  }
  if (context.databaseProvider === "postgres") {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:init")}`);
  }
  if (context.databaseProvider === "mongo" && !context.databaseUrl) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:up")}`);
  }
  nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "migration:plan")}`);
  nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "migration:apply")}`);
  if (context.schemaPreset === "basic") {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "db:seed")}`);
  }
  if (options.includeDevNextStep) {
    nextSteps.push(`- ${getRunScriptCommand(context.packageManager, "dev")}`);
  }

  return nextSteps;
}

export async function executePrismaSetupContext(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
): Promise<boolean> {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const provisionResult = await provisionPrismaPostgresIfNeeded(context, projectDir);
  if (!provisionResult) {
    return false;
  }

  const didWriteDependencies = await writeDependenciesForContext(context, projectDir);
  if (!didWriteDependencies) {
    return false;
  }

  const dependenciesInstalled = await installDependenciesForContext(context, projectDir);
  if (!dependenciesInstalled) {
    return false;
  }

  const didFinalizePrismaFiles = await finalizePrismaFilesForContext(
    context,
    projectDir,
    provisionResult,
  );
  if (!didFinalizePrismaFiles) {
    return false;
  }

  const didWriteMongoDockerHelpers = await writeMongoDockerHelpersForContext(context, projectDir);
  if (!didWriteMongoDockerHelpers) {
    return false;
  }

  const emitResult = await emitPrismaNextContractForContext(context, projectDir);

  const warningLines = buildWarningLines(provisionResult.warning, emitResult.warning);
  const nextSteps = buildNextStepsForContext({
    context,
    options,
    didEmitContract: emitResult.didEmitContract,
  });

  const warningSection = warningLines.length > 0 ? `\n\n${warningLines.join("\n")}` : "";

  outro(`Setup complete.${warningSection}

Next steps:
${nextSteps.join("\n")}`);

  return true;
}
