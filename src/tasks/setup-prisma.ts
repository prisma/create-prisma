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
import {
  DEFAULT_PRISMA_NEXT_SPEC,
  getDependencyVersion,
  getPrismaNextPackageSpecifier,
  parsePrismaNextVersionSpec,
  type ResolvedPrismaNextSpec,
} from "../constants/dependencies";
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
  getDenoPrismaSpecifier,
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
  createdProjectPath?: string;
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
  prismaNextSpec: ResolvedPrismaNextSpec;
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
const DEFAULT_AUTOMATED_PRISMA_POSTGRES = true;

const MONGO_MEMORY_SERVER_SCRIPT = `import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const defaultDatabaseUrl = "mongodb://localhost:27017/mydb?replicaSet=rs0&directConnection=true";
const dataRoot = path.resolve(process.env.MONGO_DB_PATH ?? ".mongo-data");
const dbPath = path.join(dataRoot, "db");
const pidFile = path.join(dataRoot, "mongo.pid");
const logFile = path.join(dataRoot, "mongo.log");
const readyTimeoutMs = Number(process.env.MONGO_READY_TIMEOUT_MS ?? 60_000);

function getMongoConfig() {
  const databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl;
  const url = new URL(databaseUrl);
  if (url.protocol !== "mongodb:") {
    throw new Error("DATABASE_URL must use the mongodb:// protocol.");
  }

  const port = Number(url.port || "27017");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(\`DATABASE_URL has an invalid MongoDB port: \${url.port}\`);
  }

  return {
    databaseUrl,
    port,
    replSetName: url.searchParams.get("replicaSet") || "rs0",
  };
}

function readPid() {
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getChildCommand() {
  const scriptPath = path.resolve(process.argv[1] ?? "");
  const versions = process.versions;
  if (versions.deno) return { command: process.execPath, args: ["run", "-A", scriptPath, "_run"] };
  return { command: process.execPath, args: [scriptPath, "_run"] };
}

async function runServer() {
  mkdirSync(dbPath, { recursive: true });
  const config = getMongoConfig();
  const memoryServer = await import("mongodb-memory-server");
  const { MongoMemoryReplSet } = memoryServer.default ?? memoryServer;
  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: config.replSetName, count: 1 },
    instanceOpts: [{ port: config.port, storageEngine: "wiredTiger", dbPath }],
  });
  console.log(\`MongoDB server ready for \${config.databaseUrl}\`);
  console.log(\`Data directory: \${dbPath}\`);
  const shutdown = async () => {
    await replSet.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function up() {
  mkdirSync(dataRoot, { recursive: true });
  const existing = readPid();
  if (existing !== null && isAlive(existing)) {
    console.log(\`MongoDB is already running (PID \${existing}). Use \\\`db:down\\\` to stop.\`);
    return;
  }
  if (existing !== null) rmSync(pidFile, { force: true });

  writeFileSync(logFile, "");
  const logFd = openSync(logFile, "a");
  const { command, args } = getChildCommand();
  const child = spawn(
    command,
    args,
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    },
  );
  closeSync(logFd);
  if (typeof child.pid !== "number") throw new Error("Failed to spawn MongoDB child process.");
  writeFileSync(pidFile, String(child.pid));
  child.unref();

  const start = Date.now();
  while (Date.now() - start < readyTimeoutMs) {
    if (!isAlive(child.pid)) {
      console.error("MongoDB failed to start:");
      console.error(readFileSync(logFile, "utf8"));
      rmSync(pidFile, { force: true });
      process.exit(1);
    }
    const log = readFileSync(logFile, "utf8");
    if (log.includes("MongoDB server ready")) {
      for (const line of log.split("\\n")) {
        if (line.trim().length > 0) console.log(line);
      }
      console.log(\`Detached (PID \${child.pid}). Logs: \${logFile}\`);
      console.log("Stop with \`db:down\` or wipe with \`db:reset\`.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error(\`Timed out waiting for MongoDB after \${readyTimeoutMs}ms.\`);
  console.error(readFileSync(logFile, "utf8"));
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // ignore
  }
  rmSync(pidFile, { force: true });
  process.exit(1);
}

async function down(wipe) {
  const pid = readPid();
  if (pid !== null && isAlive(pid)) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isAlive(pid)) {
      console.warn(\`MongoDB (PID \${pid}) did not exit within 10s; sending SIGKILL.\`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    console.log(\`Stopped MongoDB (PID \${pid}).\`);
  } else if (pid !== null) {
    console.log("MongoDB was not running (stale PID file).");
  } else {
    console.log("MongoDB is not running.");
  }
  rmSync(pidFile, { force: true });
  if (wipe) {
    rmSync(dataRoot, { recursive: true, force: true });
    console.log(\`Removed \${dataRoot}.\`);
  }
}

const cmd = process.argv[2] ?? "up";
switch (cmd) {
  case "up":
    await up();
    break;
  case "down":
    await down(false);
    break;
  case "reset":
    await down(true);
    break;
  case "_run":
    await runServer();
    break;
  default:
    console.error(\`Unknown command: \${cmd}. Use: up | down | reset\`);
    process.exit(2);
}
`;

function getMongoMemoryScripts(packageManager: PackageManager): Record<string, string> {
  switch (packageManager) {
    case "bun":
      return {
        "db:up": "bun --env-file=.env scripts/mongo.mjs up",
        "db:down": "bun --env-file=.env scripts/mongo.mjs down",
        "db:reset": "bun --env-file=.env scripts/mongo.mjs reset",
      };
    case "deno":
      return {
        "db:up": "deno run -A --env-file=.env scripts/mongo.mjs up",
        "db:down": "deno run -A --env-file=.env scripts/mongo.mjs down",
        "db:reset": "deno run -A --env-file=.env scripts/mongo.mjs reset",
      };
    default:
      return {
        "db:up": "node --env-file=.env scripts/mongo.mjs up",
        "db:down": "node --env-file=.env scripts/mongo.mjs down",
        "db:reset": "node --env-file=.env scripts/mongo.mjs reset",
      };
  }
}

const requiredPrismaFileGroups = [
  ["src/prisma/contract.prisma", "src/prisma/contract.ts"],
  ["prisma-next.config.ts"],
  ["src/prisma/db.ts"],
] as const;

function getContractPath(authoring: AuthoringStyle): string {
  return `src/prisma/contract${authoring === "typescript" ? ".ts" : ".prisma"}`;
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

async function resolvePrismaPostgresChoice(options: {
  explicitChoice?: boolean;
  databaseProvider: DatabaseProvider;
  databaseUrl?: string;
  useDefaults: boolean;
}): Promise<boolean | undefined> {
  const { explicitChoice, databaseProvider, databaseUrl, useDefaults } = options;

  if (explicitChoice !== undefined) {
    return explicitChoice;
  }

  if (databaseProvider !== "postgres" || databaseUrl) {
    return false;
  }

  return useDefaults ? DEFAULT_AUTOMATED_PRISMA_POSTGRES : await promptForPrismaPostgres();
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

  let prismaNextSpec: ResolvedPrismaNextSpec;
  try {
    prismaNextSpec = parsePrismaNextVersionSpec(input.prismaNextVersion);
  } catch (error) {
    cancel(error instanceof Error ? error.message : String(error));
    return;
  }

  const databaseProvider =
    input.provider ?? (useDefaults ? DEFAULT_DATABASE_PROVIDER : await promptForDatabaseProvider());
  if (!databaseProvider) {
    return;
  }

  const databaseUrl = input.databaseUrl;
  const shouldUsePrismaPostgres = await resolvePrismaPostgresChoice({
    explicitChoice: input.prismaPostgres,
    databaseProvider,
    databaseUrl,
    useDefaults,
  });
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
    prismaNextSpec,
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
  const scriptPath = path.join(projectDir, "scripts", "mongo.mjs");
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

  const memoryServerVersion = getDependencyVersion("mongodb-memory-server");
  if (packageJson.devDependencies["mongodb-memory-server"] === memoryServerVersion) {
    return;
  }

  packageJson.devDependencies["mongodb-memory-server"] = memoryServerVersion;
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
    await ensureGitignoreEntry(projectDir, ".mongo-data");
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
      context.prismaNextSpec,
    );
    return true;
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

function getPrismaNextCliPackageSpecifier(
  prismaNextSpec: ResolvedPrismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
): string {
  return getPrismaNextPackageSpecifier("prisma-next", prismaNextSpec);
}

function getPrismaNextInitTarget(provider: DatabaseProvider): "mongodb" | "postgres" {
  return provider === "mongo" ? "mongodb" : "postgres";
}

function getPrismaNextInitCliArgs(
  packageManager: PackageManager,
  prismaNextArgs: string[],
  prismaNextSpec: ResolvedPrismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
): { command: string; args: string[] } {
  if (packageManager === "npm") {
    return {
      command: "npx",
      args: ["--yes", getPrismaNextCliPackageSpecifier(prismaNextSpec), "init", ...prismaNextArgs],
    };
  }

  return getPackageExecutionArgs(packageManager, [
    getPrismaNextCliPackageSpecifier(prismaNextSpec),
    "init",
    ...prismaNextArgs,
  ]);
}

function getPrismaNextInitCliCommand(
  packageManager: PackageManager,
  prismaNextArgs: string[],
  prismaNextSpec: ResolvedPrismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
): string {
  const execution = getPrismaNextInitCliArgs(packageManager, prismaNextArgs, prismaNextSpec);
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
  const initCommand = getPrismaNextInitCliCommand(
    context.packageManager,
    initArgs,
    context.prismaNextSpec,
  );

  if (context.verbose) {
    log.step(`Running ${initCommand}`);
  }

  try {
    const initExecution = getPrismaNextInitCliArgs(
      context.packageManager,
      initArgs,
      context.prismaNextSpec,
    );
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
    return `deno run -A --env-file=.env ${getDenoPrismaSpecifier()} ${prismaNextArgs.join(" ")}`;
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
      args: ["run", "-A", "--env-file=.env", getDenoPrismaSpecifier(), ...prismaNextArgs],
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
      description:
        "Start the local MongoDB replica set with mongodb-memory-server. Stop with `db:down`, wipe with `db:reset`.",
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
    description: "Insert the sample users from src/prisma/seed.ts.",
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

  const didWriteMongoLocalHelpers = await writeMongoLocalHelpersForContext(context, projectDir);
  if (!didWriteMongoLocalHelpers) {
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

  if (options.createdProjectPath) {
    note(path.resolve(options.createdProjectPath), "Project path");
  }

  note(formatAgentPrompt(), "Agent prompt");
  if (context.verbose) {
    note(formatNextSteps(nextSteps), "Next steps for Prisma Next");
  }
  outro("Prisma Next setup complete.");

  return true;
}
