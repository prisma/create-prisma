import { cancel, confirm, isCancel, log, spinner } from "@clack/prompts";
import { execa, type Options as ExecaOptions } from "execa";

import {
  isComputeDeployableTemplate,
  type CreateCommandInput,
  type CreateTemplate,
  type PackageManager,
} from "../types";
import { getPackageExecutionArgs, getPackageExecutionCommand } from "../utils/package-manager";

const PRISMA_CLI_PACKAGE = "@prisma/cli@latest";

const DEPLOY_OPTIONS_BY_TEMPLATE: Partial<
  Record<
    CreateTemplate,
    {
      configTarget?: string;
    }
  >
> = {
  hono: {},
  elysia: {},
  nest: {},
  next: {},
  astro: {},
  nuxt: {},
  "tanstack-start": {},
  turborepo: {
    configTarget: "api",
  },
};

type PrismaCliJsonError = { message?: string; summary?: string; name?: string };

type PrismaCliJsonEnvelope<T> =
  | {
      ok: true;
      result: T;
    }
  | { ok: false; error: PrismaCliJsonError };

type AppDeployJsonPayload = {
  project: {
    id: string;
    name: string;
  };
  branch: {
    name: string;
  };
  app: {
    id: string;
    name: string;
  };
  deployment: {
    id: string;
    status: string;
    url: string | null;
  };
  branchDatabase?: {
    status: "created" | "skipped";
    database?: {
      id: string;
      name: string;
    };
  };
};

type ProjectCreateJsonPayload = {
  project: {
    id: string;
    name: string;
  };
};

type DatabaseCreateJsonPayload = {
  projectId: string;
  projectName: string;
  database: {
    id: string;
    name: string;
  };
  connectionString: string;
};

export type ComputeDeployContext = {
  template: CreateTemplate;
  packageManager: PackageManager;
  createProjectName: string;
  configTarget?: string;
};

export type ComputeDeployResult = {
  appUrl: string | null;
  appId: string;
  appName: string;
  deploymentId: string;
  projectId: string;
  projectName: string;
  branchName: string;
  database?: {
    id: string;
    name: string;
  };
};

export type ComputeDatabaseResult = {
  databaseUrl: string;
  projectId: string;
  projectName: string;
  database: {
    id: string;
    name: string;
  };
};

function getPrismaCliCommand(packageManager: PackageManager): string {
  return getPackageExecutionCommand(getPrismaCliExecutionPackageManager(packageManager), [
    PRISMA_CLI_PACKAGE,
  ]);
}

function getPrismaCliAppDeployCommand(packageManager: PackageManager): string {
  return getPackageExecutionCommand(
    getPrismaCliExecutionPackageManager(packageManager),
    [PRISMA_CLI_PACKAGE, "app", "deploy"],
    { silent: true },
  );
}

export function getComputeDeployScriptMap(context: ComputeDeployContext): Record<string, string> {
  const deployArgs = [...getComputeDeployTargetArgs(context), "--prod", "--yes"];
  const deployCommand = [getPrismaCliAppDeployCommand(context.packageManager), ...deployArgs].join(
    " ",
  );

  return {
    "compute:deploy": deployCommand,
  };
}

function getComputeDeployTargetArgs(context: ComputeDeployContext): string[] {
  return context.configTarget ? [context.configTarget] : [];
}

function runPrismaCli(
  packageManager: PackageManager,
  args: string[],
  options: ExecaOptions & { silentPackageRunner?: boolean } = {},
) {
  const { silentPackageRunner, ...execaOptions } = options;
  const execution = getPackageExecutionArgs(
    getPrismaCliExecutionPackageManager(packageManager),
    [PRISMA_CLI_PACKAGE, ...args],
    { silent: silentPackageRunner },
  );
  return execa(execution.command, execution.args, execaOptions);
}

function getPrismaCliExecutionPackageManager(packageManager: PackageManager): PackageManager {
  // @prisma/cli is a Node CLI; Deno's npm runner currently fails to load its dependencies.
  return packageManager === "deno" ? "npm" : packageManager;
}

async function isAuthenticated(packageManager: PackageManager): Promise<boolean> {
  try {
    await runPrismaCli(packageManager, ["project", "list", "--json"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function ensurePrismaCliAvailable(packageManager: PackageManager): Promise<boolean> {
  try {
    await runPrismaCli(packageManager, ["--help"], { stdio: "pipe" });
    return true;
  } catch (error) {
    const command = getPrismaCliCommand(packageManager);
    const isMissing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";
    if (isMissing) {
      log.warn(`Could not find the selected package manager. Re-run ${command} manually.`);
      return false;
    }
    log.warn(
      `Could not run ${command}${error instanceof Error ? `: ${redactSecrets(error.message)}` : "."}`,
    );
    return false;
  }
}

export async function collectComputeDeployContext(
  input: CreateCommandInput,
  options: {
    template: CreateTemplate;
    packageManager: PackageManager;
    useDefaults: boolean;
    defaultServiceName: string;
  },
): Promise<ComputeDeployContext | null | undefined> {
  if (!isComputeDeployableTemplate(options.template)) {
    return null;
  }

  if (input.deploy === false) {
    return null;
  }

  let wantsDeploy: boolean;
  if (input.deploy === true) {
    wantsDeploy = true;
  } else if (options.useDefaults) {
    return null;
  } else {
    const confirmed = await confirm({
      message: "Deploy to Prisma Compute now?",
      initialValue: false,
    });
    if (isCancel(confirmed)) {
      cancel("Operation cancelled.");
      return undefined;
    }
    wantsDeploy = confirmed;
  }

  if (!wantsDeploy) return null;

  if (!(await ensurePrismaCliAvailable(options.packageManager))) {
    if (input.deploy === true) {
      throw createExplicitDeployError("the Prisma CLI is not available");
    }
    return null;
  }

  if (!(await isAuthenticated(options.packageManager))) {
    log.info("Authenticating with Prisma...");
    try {
      await runPrismaCli(options.packageManager, ["auth", "login"], { stdio: "inherit" });
    } catch (error) {
      log.warn(
        `Prisma login was not completed${error instanceof Error ? `: ${redactSecrets(error.message)}` : "."}`,
      );
      if (input.deploy === true) {
        throw createExplicitDeployError("authentication failed", error);
      }
      return null;
    }
  }

  const deployOptions = DEPLOY_OPTIONS_BY_TEMPLATE[options.template];
  if (!deployOptions) {
    if (input.deploy === true) {
      throw createExplicitDeployError(
        `${options.template} is not supported by prisma app deploy yet`,
      );
    }
    return null;
  }

  return {
    template: options.template,
    packageManager: options.packageManager,
    createProjectName: options.defaultServiceName,
    configTarget: deployOptions.configTarget,
  };
}

function redactSecrets(message: string): string {
  return message
    .replace(
      /(['"])([A-Z0-9_]*(?:DATABASE_URL|DIRECT_URL|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*=)(.*?)\1/g,
      "$1$2<redacted>$1",
    )
    .replace(
      /\b([A-Z0-9_]*(?:DATABASE_URL|DIRECT_URL|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*=)[^\s]+/g,
      "$1<redacted>",
    );
}

function parseJson<T>(stdout: unknown): T | null {
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

function getJsonErrorMessage(error: PrismaCliJsonError | undefined, fallback: string): string {
  return error?.summary ?? error?.message ?? error?.name ?? fallback;
}

function getErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function createDeployError(message: string | undefined): Error {
  return new Error(redactSecrets(message ?? "unknown error"));
}

function createExplicitDeployError(reason: string, error?: unknown): Error {
  const detail = error instanceof Error ? `: ${redactSecrets(error.message)}` : "";
  return new Error(`Deploy requested but ${reason}${detail}`);
}

async function runPrismaCliJson<T>(params: {
  packageManager: PackageManager;
  args: string[];
  cwd: string;
  fallbackError: string;
  invalidOutputError: string;
}): Promise<{ ok: true; result: T } | { ok: false; error: Error }> {
  try {
    const { stdout, exitCode } = await runPrismaCli(params.packageManager, params.args, {
      cwd: params.cwd,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
      silentPackageRunner: true,
    });

    const parsed = parseJson<PrismaCliJsonEnvelope<T>>(stdout);
    if (!parsed) {
      return { ok: false, error: new Error(params.invalidOutputError) };
    }
    if (exitCode !== 0 || !parsed.ok) {
      return {
        ok: false,
        error: createDeployError(
          parsed.ok
            ? params.fallbackError
            : getJsonErrorMessage(parsed.error, params.fallbackError),
        ),
      };
    }

    return { ok: true, result: parsed.result };
  } catch (error) {
    return { ok: false, error: new Error(getErrorMessage(error)) };
  }
}

function toComputeDeployResult(data: AppDeployJsonPayload): ComputeDeployResult {
  return {
    appUrl: data.deployment.url,
    appId: data.app.id,
    appName: data.app.name,
    deploymentId: data.deployment.id,
    projectId: data.project.id,
    projectName: data.project.name,
    branchName: data.branch.name,
    database: data.branchDatabase?.database,
  };
}

export async function executeComputeDatabaseSetup(params: {
  context: ComputeDeployContext;
  projectDir: string;
}): Promise<
  { ok: true; result: ComputeDatabaseResult } | { ok: false; cancelled: boolean; error?: unknown }
> {
  const projectSpinner = spinner();
  projectSpinner.start("Creating Prisma Compute project...");

  const projectResult = await runPrismaCliJson<ProjectCreateJsonPayload>({
    packageManager: params.context.packageManager,
    args: ["project", "create", params.context.createProjectName, "--json"],
    cwd: params.projectDir,
    fallbackError: "Prisma project create failed.",
    invalidOutputError: "Invalid prisma project create output",
  });
  if (!projectResult.ok) {
    projectSpinner.error(`Project creation failed: ${projectResult.error.message}`);
    return { ok: false, cancelled: false, error: projectResult.error };
  }
  projectSpinner.stop("Prisma Compute project created.");

  const databaseSpinner = spinner();
  databaseSpinner.start("Creating Prisma Postgres database...");
  const databaseResult = await runPrismaCliJson<DatabaseCreateJsonPayload>({
    packageManager: params.context.packageManager,
    args: ["database", "create", "main", "--branch", "main", "--json"],
    cwd: params.projectDir,
    fallbackError: "Prisma database create failed.",
    invalidOutputError: "Invalid prisma database create output",
  });
  if (!databaseResult.ok) {
    databaseSpinner.error(`Database creation failed: ${databaseResult.error.message}`);
    return { ok: false, cancelled: false, error: databaseResult.error };
  }
  databaseSpinner.stop("Prisma Postgres database created.");

  return {
    ok: true,
    result: {
      databaseUrl: databaseResult.result.connectionString,
      projectId: databaseResult.result.projectId,
      projectName: databaseResult.result.projectName,
      database: databaseResult.result.database,
    },
  };
}

export async function executeComputeDeployContext(params: {
  context: ComputeDeployContext;
  projectDir: string;
  createProject?: boolean;
}): Promise<
  { ok: true; result: ComputeDeployResult } | { ok: false; cancelled: boolean; error?: unknown }
> {
  const deploySpinner = spinner();
  deploySpinner.start("Deploying to Prisma Compute...");
  const args = [
    "app",
    "deploy",
    ...getComputeDeployTargetArgs(params.context),
    "--json",
    "--yes",
    "--prod",
    ...(params.createProject === false
      ? []
      : ["--create-project", params.context.createProjectName]),
  ];

  const deployResult = await runPrismaCliJson<AppDeployJsonPayload>({
    packageManager: params.context.packageManager,
    args,
    cwd: params.projectDir,
    fallbackError: "Prisma app deploy failed.",
    invalidOutputError: "Invalid prisma app deploy output",
  });
  if (!deployResult.ok) {
    deploySpinner.error(`Deploy failed: ${deployResult.error.message}`);
    return { ok: false, cancelled: false, error: deployResult.error };
  }

  deploySpinner.stop("Deployed to Prisma Compute.");
  return {
    ok: true,
    result: toComputeDeployResult(deployResult.result),
  };
}
