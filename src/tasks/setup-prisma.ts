import { cancel, confirm, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import { installProjectDependencies, writePrismaDependencies } from "./install";
import {
  getCreateDbCommand,
  PRISMA_POSTGRES_TEMPORARY_NOTICE,
  provisionPrismaPostgres,
} from "./prisma-postgres";
import { getPrismaNextPackageSpecifier } from "../constants/dependencies";
import {
  AuthoringStyleSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
  type AuthoringStyle,
  type DatabaseProvider,
  type PackageManager,
  type PrismaSetupCommandInput,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
  getPackageExecutionArgs,
  getLocalPackageBinaryArgs,
  getLocalPackageBinaryCommand,
  getRunScriptCommand,
} from "../utils/package-manager";

type EnvWriteMode = "keep-existing" | "upsert";

type PrismaSetupRunOptions = {
  prependNextSteps?: NextStep[];
  projectDir?: string;
  includeDevNextStep?: boolean;
  progressSpinner?: ReturnType<typeof spinner>;
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

type NextStep = {
  command: string;
  description: string;
};

export type PrismaSetupContext = {
  projectDir: string;
  verbose: boolean;
  shouldEmit: boolean;
  databaseProvider: DatabaseProvider;
  authoring: AuthoringStyle;
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
const DEFAULT_INSTALL = true;
const DEFAULT_EMIT = true;
const DEFAULT_INTERACTIVE_PRISMA_POSTGRES = true;
const DEFAULT_AUTOMATED_PRISMA_POSTGRES = false;

const MONGO_MEMORY_SERVER_VERSION = "^11.1.0";

const MONGO_MEMORY_SERVER_SCRIPT = `import { MongoMemoryReplSet } from "mongodb-memory-server";

const port = Number(process.env.MONGO_PORT ?? 27017);
const replSetName = process.env.MONGO_REPLSET ?? "rs0";

const replSet = await MongoMemoryReplSet.create({
  replSet: { name: replSetName, count: 1, storageEngine: "wiredTiger" },
  instanceOpts: [{ port, storageEngine: "wiredTiger" }],
});

console.log(\`MongoDB memory server ready at \${replSet.getUri()}\`);
console.log("Press Ctrl+C to stop.");

const shutdown = async () => {
  await replSet.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`;

function getMongoMemoryScripts(packageManager: PackageManager): Record<string, string> {
  switch (packageManager) {
    case "bun":
      return { "db:up": "bun scripts/start-mongo.ts" };
    case "deno":
      return { "db:up": "deno run -A scripts/start-mongo.ts" };
    default:
      return { "db:up": "tsx scripts/start-mongo.ts" };
  }
}

const requiredPrismaFileGroups = [
  ["prisma/contract.prisma", "prisma/contract.ts"],
  ["prisma-next.config.ts"],
  [
    "src/lib/prisma.ts",
    "src/lib/prisma.server.ts",
    "src/lib/server/prisma.ts",
    "server/utils/prisma.ts",
  ],
] as const;

function getContractPath(authoring: AuthoringStyle): string {
  return `prisma/contract${authoring === "typescript" ? ".ts" : ".prisma"}`;
}

async function promptForDatabaseProvider(): Promise<DatabaseProvider | undefined> {
  const databaseProvider = await select({
    message: "Select your database",
    initialValue: DEFAULT_DATABASE_PROVIDER,
    options: [
      {
        value: "postgres",
        label: "PostgreSQL",
        hint: "Relational models with typed ORM, relations, indexes, raw SQL",
      },
      {
        value: "mongo",
        label: "MongoDB",
        hint: "Document models with typed ORM, indexes, aggregations",
      },
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
      { value: "psl", label: "PSL", hint: "Schema syntax emits contract.json + types" },
      {
        value: "typescript",
        label: "TypeScript",
        hint: "Builder API emits the same contract artifacts",
      },
    ],
  });

  if (isCancel(authoring)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return AuthoringStyleSchema.parse(authoring);
}

async function promptForPrismaPostgres(): Promise<boolean | undefined> {
  const shouldUsePrismaPostgres = await confirm({
    message: "Provision a Prisma Postgres database?",
    active: "Provision Prisma Postgres",
    inactive: "Use my own database",
    initialValue: DEFAULT_INTERACTIVE_PRISMA_POSTGRES,
  });

  if (isCancel(shouldUsePrismaPostgres)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return Boolean(shouldUsePrismaPostgres);
}

function getPackageManagerHint(
  option: PackageManager,
  detected: PackageManager,
): string | undefined {
  const hintByPackageManager = {
    npm: "Node.js default",
    pnpm: "Fast, disk-efficient Node.js package manager",
    yarn: "Yarn package manager",
    bun: "Fast runtime + package manager",
    deno: "Deno runtime + task runner",
  } satisfies Record<PackageManager, string>;

  const hint = hintByPackageManager[option];
  return option === detected ? `Detected; ${hint}` : hint;
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
    message: `Install dependencies now with ${installCommand}? You can run it later.`,
    active: "Install now",
    inactive: "Skip for now",
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

  const databaseUrl = input.databaseUrl;
  const shouldUsePrismaPostgres =
    input.prismaPostgres ??
    (databaseProvider === "postgres" && !databaseUrl && !useDefaults
      ? await promptForPrismaPostgres()
      : DEFAULT_AUTOMATED_PRISMA_POSTGRES);
  if (shouldUsePrismaPostgres === undefined) {
    return;
  }

  if (shouldUsePrismaPostgres && databaseProvider !== "postgres") {
    cancel("--prisma-postgres is only supported with --provider postgres.");
    return;
  }
  if (shouldUsePrismaPostgres && databaseUrl) {
    cancel("Use either --database-url or --prisma-postgres, not both.");
    return;
  }

  const authoring =
    input.authoring ?? (useDefaults ? DEFAULT_AUTHORING : await promptForAuthoringStyle());
  if (!authoring) {
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

async function ensureMongoMemoryServerScript(projectDir: string): Promise<void> {
  const scriptPath = path.join(projectDir, "scripts", "start-mongo.ts");
  if (await fs.pathExists(scriptPath)) {
    return;
  }

  await fs.ensureDir(path.dirname(scriptPath));
  await fs.writeFile(scriptPath, MONGO_MEMORY_SERVER_SCRIPT, "utf8");
}

async function ensureMongoMemoryServerDevDependency(projectDir: string): Promise<void> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return;
  }

  const packageJson = await fs.readJson(packageJsonPath);
  if (!packageJson.devDependencies) {
    packageJson.devDependencies = {};
  }

  if (packageJson.devDependencies["mongodb-memory-server"] === MONGO_MEMORY_SERVER_VERSION) {
    return;
  }

  packageJson.devDependencies["mongodb-memory-server"] = MONGO_MEMORY_SERVER_VERSION;
  packageJson.devDependencies = Object.fromEntries(
    Object.entries(packageJson.devDependencies as Record<string, string>).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );

  await fs.writeJson(packageJsonPath, packageJson, {
    spaces: 2,
  });
}

async function writeMongoLocalHelpersForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  if (context.databaseProvider !== "mongo" || context.databaseUrl) {
    return true;
  }

  try {
    await ensureMongoMemoryServerScript(projectDir);
    await ensureMongoMemoryServerDevDependency(projectDir);
    await ensurePackageScripts(projectDir, getMongoMemoryScripts(context.packageManager));
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

  await ensureRequiredPrismaFiles(projectDir);

  const databaseUrl = options.databaseUrl ?? getDefaultDatabaseUrl(options.provider);
  await ensureEnvVarInEnv(projectDir, "DATABASE_URL", databaseUrl, {
    mode: options.databaseUrl ? "upsert" : "keep-existing",
    comment: "Added by create-prisma",
  });

  if (options.claimUrl) {
    await ensureEnvVarInEnv(projectDir, "CLAIM_URL", options.claimUrl, {
      mode: "upsert",
      comment: PRISMA_POSTGRES_TEMPORARY_NOTICE,
    });
    await ensureEnvComment(projectDir, PRISMA_POSTGRES_TEMPORARY_NOTICE);
  }

  await ensureGitignoreEntry(projectDir, ".env");
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
  if (context.verbose) {
    log.step(`Running ${createDbCommand}`);
  }

  try {
    const prismaPostgresResult = await provisionPrismaPostgres(context.packageManager, projectDir);

    if (context.verbose) {
      log.success("Prisma Postgres database provisioned.");
    }
    return {
      databaseUrl: prismaPostgresResult.databaseUrl,
      claimUrl: prismaPostgresResult.claimUrl,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

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
  try {
    await writePrismaDependencies(
      context.databaseProvider,
      context.packageManager,
      context.authoring,
      projectDir,
    );
    return true;
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

function getPrismaNextCliPackageSpecifier(): string {
  return getPrismaNextPackageSpecifier("prisma-next");
}

function getPrismaNextInitTarget(provider: DatabaseProvider): "mongodb" | "postgres" {
  return provider === "mongo" ? "mongodb" : "postgres";
}

function getPrismaNextInitCliArgs(
  packageManager: PackageManager,
  prismaNextArgs: string[],
): { command: string; args: string[] } {
  if (packageManager === "npm") {
    return {
      command: "npx",
      args: ["--yes", getPrismaNextCliPackageSpecifier(), "init", ...prismaNextArgs],
    };
  }

  return getPackageExecutionArgs(packageManager, [
    getPrismaNextCliPackageSpecifier(),
    "init",
    ...prismaNextArgs,
  ]);
}

function getPrismaNextInitCliCommand(
  packageManager: PackageManager,
  prismaNextArgs: string[],
): string {
  const execution = getPrismaNextInitCliArgs(packageManager, prismaNextArgs);
  return [execution.command, ...execution.args].join(" ");
}

async function runPrismaNextInitForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  const initArgs = [
    "--yes",
    "--force",
    "--target",
    getPrismaNextInitTarget(context.databaseProvider),
    "--authoring",
    context.authoring,
    "--schema-path",
    getContractPath(context.authoring),
    "--no-install",
  ];
  const initCommand = getPrismaNextInitCliCommand(context.packageManager, initArgs);

  if (context.verbose) {
    log.step(`Running ${initCommand}`);
  }

  try {
    const initExecution = getPrismaNextInitCliArgs(context.packageManager, initArgs);
    await execa(initExecution.command, initExecution.args, {
      cwd: projectDir,
      stdio: context.verbose ? "inherit" : "pipe",
      env: {
        ...process.env,
        CI: "1",
      },
    });

    if (context.verbose) {
      log.success("Prisma Next project files ready.");
    }
    return true;
  } catch (error) {
    if (context.verbose) {
      log.warn("Could not run Prisma Next init.");
    }
    cancel(`Failed to run ${initCommand}: ${getCommandErrorMessage(error)}`);
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
  }

  try {
    await installProjectDependencies(context.packageManager, projectDir, {
      verbose: context.verbose,
    });
    if (context.verbose) {
      log.success("Dependencies installed.");
    }
    return true;
  } catch (error) {
    cancel(`Failed to run ${installCommand}: ${getCommandErrorMessage(error)}`);
    return false;
  }
}

async function finalizePrismaFilesForContext(
  context: PrismaSetupContext,
  projectDir: string,
  provisionResult: PrismaPostgresProvisionResult,
): Promise<boolean> {
  try {
    await finalizePrismaFiles({
      provider: context.databaseProvider,
      databaseUrl: provisionResult.databaseUrl,
      claimUrl: provisionResult.claimUrl,
      projectDir,
    });

    if (context.verbose) {
      log.success("Prisma Next environment configured.");
    }
    return true;
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

function getPrismaNextCliCommand(packageManager: PackageManager, prismaNextArgs: string[]): string {
  if (packageManager === "deno") {
    return `deno run -A --env-file=.env npm:${getPrismaNextCliPackageSpecifier()} ${prismaNextArgs.join(" ")}`;
  }

  return getLocalPackageBinaryCommand(packageManager, "prisma-next", prismaNextArgs);
}

function getPrismaNextCliArgs(
  packageManager: PackageManager,
  prismaNextArgs: string[],
): { command: string; args: string[] } {
  if (packageManager === "deno") {
    return {
      command: "deno",
      args: [
        "run",
        "-A",
        "--env-file=.env",
        `npm:${getPrismaNextCliPackageSpecifier()}`,
        ...prismaNextArgs,
      ],
    };
  }

  return getLocalPackageBinaryArgs(packageManager, "prisma-next", prismaNextArgs);
}

async function emitPrismaNextContractForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<PrismaNextEmitResult> {
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

  try {
    const emitArgs = getPrismaNextCliArgs(context.packageManager, ["contract", "emit"]);
    await execa(emitArgs.command, emitArgs.args, {
      cwd: projectDir,
      stdio: context.verbose ? "inherit" : "pipe",
    });
    if (context.verbose) {
      log.success("Prisma Next contract artifacts emitted.");
    }

    return {
      didEmitContract: true,
    };
  } catch (error) {
    if (context.verbose) {
      log.warn("Could not emit Prisma Next contract.");
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
}): NextStep[] {
  const { context, options, didEmitContract } = opts;
  const nextSteps: NextStep[] = [...(options.prependNextSteps ?? [])];

  if (!context.shouldInstall) {
    nextSteps.push({
      command: getInstallCommand(context.packageManager),
      description: "Install the project dependencies.",
    });
  }
  if (!didEmitContract || !context.shouldEmit) {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "contract:emit"),
      description: "Emit contract.json and TypeScript types from your Prisma Next contract.",
    });
  }
  if (context.databaseProvider === "postgres") {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "db:init"),
      description: "Create the initial PostgreSQL database objects and sign the database.",
    });
  }
  if (context.databaseProvider === "mongo" && !context.databaseUrl) {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "db:up"),
      description: "Start the local in-memory MongoDB replica set (mongodb-memory-server).",
    });
  }
  nextSteps.push({
    command: getRunScriptCommand(context.packageManager, "migration:plan"),
    description: "Compare the contract to the database and write a migration plan.",
  });
  nextSteps.push({
    command: getRunScriptCommand(context.packageManager, "migrate"),
    description: "Apply the planned migration to the database.",
  });
  nextSteps.push({
    command: getRunScriptCommand(context.packageManager, "db:seed"),
    description: "Insert the sample user and post data from prisma/seed.ts.",
  });
  if (options.includeDevNextStep) {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "dev"),
      description: "Start the development server.",
    });
  }

  return nextSteps;
}

function formatNextSteps(nextSteps: NextStep[]): string {
  return nextSteps.map((step) => `${step.command}\n  ${step.description}`).join("\n\n");
}

function formatAgentPrompt(): string {
  return [
    "Ask your agent:",
    "What can I do with Prisma Next?",
    "",
    "Learn more:",
    `Docs: prisma-next.md`,
    "Skills: https://github.com/prisma/prisma-next/tree/main/skills",
  ].join("\n");
}

export async function executePrismaSetupContext(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
): Promise<boolean> {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const progressSpinner = context.verbose ? undefined : (options.progressSpinner ?? spinner());
  const ownsProgressSpinner = progressSpinner !== undefined && !options.progressSpinner;

  if (ownsProgressSpinner) {
    progressSpinner.start("Creating Prisma Next project...");
  }

  const stopProgressOnFailure = () => {
    progressSpinner?.stop("Could not create Prisma Next project.");
  };

  if (context.shouldUsePrismaPostgres) {
    progressSpinner?.message("Provisioning Prisma Postgres...");
  }
  const provisionResult = await provisionPrismaPostgresIfNeeded(context, projectDir);
  if (!provisionResult) {
    stopProgressOnFailure();
    return false;
  }

  progressSpinner?.message("Preparing Prisma Next project files...");
  const didRunPrismaNextInit = await runPrismaNextInitForContext(context, projectDir);
  if (!didRunPrismaNextInit) {
    stopProgressOnFailure();
    return false;
  }

  const didWriteDependencies = await writeDependenciesForContext(context, projectDir);
  if (!didWriteDependencies) {
    stopProgressOnFailure();
    return false;
  }

  if (context.shouldInstall) {
    progressSpinner?.message("Installing dependencies...");
  }
  const dependenciesInstalled = await installDependenciesForContext(context, projectDir);
  if (!dependenciesInstalled) {
    stopProgressOnFailure();
    return false;
  }

  progressSpinner?.message("Configuring Prisma Next...");
  const didFinalizePrismaFiles = await finalizePrismaFilesForContext(
    context,
    projectDir,
    provisionResult,
  );
  if (!didFinalizePrismaFiles) {
    stopProgressOnFailure();
    return false;
  }

  const didWriteMongoLocalHelpers = await writeMongoLocalHelpersForContext(context, projectDir);
  if (!didWriteMongoLocalHelpers) {
    stopProgressOnFailure();
    return false;
  }

  if (context.shouldEmit && context.shouldInstall) {
    progressSpinner?.message("Emitting Prisma Next contract artifacts...");
  }
  const emitResult = await emitPrismaNextContractForContext(context, projectDir);

  const warningLines = buildWarningLines(provisionResult.warning, emitResult.warning);
  const nextSteps = buildNextStepsForContext({
    context,
    options,
    didEmitContract: emitResult.didEmitContract,
  });

  progressSpinner?.stop("Prisma Next project ready.");

  if (warningLines.length > 0) {
    note(warningLines.map((line) => line.replace(/^- /, "")).join("\n"), "Heads up");
  }

  note(formatAgentPrompt(), "Agent prompt");
  if (context.verbose) {
    note(formatNextSteps(nextSteps), "Next steps for Prisma Next");
  }
  outro("Prisma Next setup complete.");

  return true;
}
