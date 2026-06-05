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
const COMPUTE_DEPLOY_BRANCH = "main";
const COMPUTE_ENV_ROLE = "production";

type DeployFramework = "nextjs" | "hono" | "tanstack-start" | "bun";

const DEPLOY_OPTIONS_BY_TEMPLATE: Partial<
  Record<CreateTemplate, { framework: DeployFramework; httpPort?: number }>
> = {
  hono: { framework: "hono", httpPort: 8080 },
  elysia: { framework: "bun", httpPort: 8080 },
  next: { framework: "nextjs" },
  "tanstack-start": { framework: "tanstack-start" },
};

type PrismaProject = {
  id: string;
  name: string;
};

type ProjectCreateJsonResult =
  | {
      ok: true;
      result: {
        project: PrismaProject;
      };
    }
  | { ok: false; error: { message?: string; summary?: string; name?: string } };

type ProjectEnvJsonResult =
  | {
      ok: true;
    }
  | { ok: false; error: { message?: string; summary?: string; name?: string } };

type AppDeployJsonResult =
  | {
      ok: true;
      result: {
        project: PrismaProject;
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
      };
    }
  | { ok: false; error: { message?: string; summary?: string; name?: string } };

export type ComputeDeployContext = {
  template: CreateTemplate;
  packageManager: PackageManager;
  createProjectName: string;
  framework: DeployFramework;
  httpPort?: number;
};

export type ComputeDeployResult = {
  appUrl: string | null;
  appId: string;
  appName: string;
  deploymentId: string;
  projectId: string;
  projectName: string;
  branchName: string;
};

function getPrismaCliCommand(packageManager: PackageManager): string {
  return getPackageExecutionCommand(getPrismaCliExecutionPackageManager(packageManager), [
    PRISMA_CLI_PACKAGE,
  ]);
}

function runPrismaCli(packageManager: PackageManager, args: string[], options: ExecaOptions = {}) {
  const execution = getPackageExecutionArgs(getPrismaCliExecutionPackageManager(packageManager), [
    PRISMA_CLI_PACKAGE,
    ...args,
  ]);
  return execa(execution.command, execution.args, options);
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
      initialValue: true,
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
    framework: deployOptions.framework,
    httpPort: deployOptions.httpPort,
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

function parseDeployJson(stdout: unknown): AppDeployJsonResult | null {
  return parsePrismaCliJson<AppDeployJsonResult>(stdout);
}

function parseProjectCreateJson(stdout: unknown): ProjectCreateJsonResult | null {
  return parsePrismaCliJson<ProjectCreateJsonResult>(stdout);
}

function parseProjectEnvJson(stdout: unknown): ProjectEnvJsonResult | null {
  return parsePrismaCliJson<ProjectEnvJsonResult>(stdout);
}

function parsePrismaCliJson<T>(stdout: unknown): T | null {
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

function getJsonErrorMessage(
  error: { message?: string; summary?: string; name?: string } | undefined,
  fallback: string,
): string {
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

function toComputeDeployResult(data: AppDeployJsonResult & { ok: true }): ComputeDeployResult {
  return {
    appUrl: data.result.deployment.url,
    appId: data.result.app.id,
    appName: data.result.app.name,
    deploymentId: data.result.deployment.id,
    projectId: data.result.project.id,
    projectName: data.result.project.name,
    branchName: data.result.branch.name,
  };
}

async function createComputeProjectForDeploy(params: {
  context: ComputeDeployContext;
  projectDir: string;
}): Promise<string> {
  const { stdout, exitCode } = await runPrismaCli(
    params.context.packageManager,
    ["project", "create", params.context.createProjectName, "--json", "--yes"],
    {
      cwd: params.projectDir,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const parsed = parseProjectCreateJson(stdout);
  if (!parsed) {
    throw new Error("Could not parse prisma project create output.");
  }
  if (exitCode !== 0 || !parsed.ok) {
    throw createDeployError(
      parsed.ok
        ? "Prisma project create failed."
        : getJsonErrorMessage(parsed.error, "Prisma project create failed."),
    );
  }

  return parsed.result.project.id;
}

async function writeComputeEnvironmentVariables(params: {
  context: ComputeDeployContext;
  projectDir: string;
  projectRef: string;
  envVars: Record<string, string> | undefined;
}): Promise<void> {
  for (const [key, value] of Object.entries(params.envVars ?? {})) {
    const assignment = `${key}=${value}`;
    const commonArgs = [
      assignment,
      "--project",
      params.projectRef,
      "--role",
      COMPUTE_ENV_ROLE,
      "--json",
      "--yes",
    ];

    const addResult = await runProjectEnvCommand(params.context, params.projectDir, [
      "add",
      ...commonArgs,
    ]);
    if (addResult.ok) {
      continue;
    }

    const updateResult = await runProjectEnvCommand(params.context, params.projectDir, [
      "update",
      ...commonArgs,
    ]);
    if (!updateResult.ok) {
      throw createDeployError(
        getJsonErrorMessage(updateResult.error, `Failed to configure ${key} for Prisma Compute.`),
      );
    }
  }
}

async function runProjectEnvCommand(
  context: ComputeDeployContext,
  projectDir: string,
  args: string[],
): Promise<ProjectEnvJsonResult> {
  const { stdout, exitCode } = await runPrismaCli(
    context.packageManager,
    ["project", "env", ...args],
    {
      cwd: projectDir,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const parsed = parseProjectEnvJson(stdout);
  if (!parsed) {
    throw new Error("Could not parse prisma project env output.");
  }
  if (exitCode !== 0 && parsed.ok) {
    return { ok: false, error: { message: "Prisma project env command failed." } };
  }
  return parsed;
}

export async function executeComputeDeployContext(params: {
  context: ComputeDeployContext;
  projectDir: string;
  envVars?: Record<string, string>;
}): Promise<
  { ok: true; result: ComputeDeployResult } | { ok: false; cancelled: boolean; error?: unknown }
> {
  const deploySpinner = spinner();
  deploySpinner.start("Deploying to Prisma Compute...");
  const envVars = params.envVars ?? {};
  // @prisma/cli@latest rejects inline deploy env vars today, so write them first.
  const shouldPreconfigureEnvVars = Object.keys(envVars).length > 0;

  const args = [
    "app",
    "deploy",
    "--json",
    "--yes",
    "--framework",
    params.context.framework,
    "--branch",
    COMPUTE_DEPLOY_BRANCH,
  ];

  try {
    if (shouldPreconfigureEnvVars) {
      const projectRef = await createComputeProjectForDeploy({
        context: params.context,
        projectDir: params.projectDir,
      });
      await writeComputeEnvironmentVariables({
        context: params.context,
        projectDir: params.projectDir,
        projectRef,
        envVars,
      });
      args.push("--project", projectRef);
    } else {
      args.push("--create-project", params.context.createProjectName);
    }

    if (params.context.httpPort) {
      args.push("--http-port", String(params.context.httpPort));
    }

    const { stdout, exitCode } = await runPrismaCli(params.context.packageManager, args, {
      cwd: params.projectDir,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const parsed = parseDeployJson(stdout);
    if (!parsed) {
      deploySpinner.error("Deploy failed: could not parse prisma app deploy output.");
      return { ok: false, cancelled: false, error: new Error("Invalid prisma app deploy output") };
    }

    if (exitCode !== 0 || !parsed.ok) {
      const error = createDeployError(
        parsed.ok
          ? "Prisma app deploy failed."
          : getJsonErrorMessage(parsed.error, "Prisma app deploy failed."),
      );
      deploySpinner.error(`Deploy failed: ${error.message}`);
      return { ok: false, cancelled: false, error };
    }

    deploySpinner.stop("Deployed to Prisma Compute.");
    return {
      ok: true,
      result: toComputeDeployResult(parsed),
    };
  } catch (error) {
    const parsed = parseDeployJson((error as { stdout?: unknown })?.stdout);
    if (parsed?.ok) {
      deploySpinner.stop("Deployed to Prisma Compute.");
      return {
        ok: true,
        result: toComputeDeployResult(parsed),
      };
    }

    if (parsed && !parsed.ok) {
      const deployError = createDeployError(
        getJsonErrorMessage(parsed.error, "Prisma app deploy failed."),
      );
      deploySpinner.error(`Deploy failed: ${deployError.message}`);
      return { ok: false, cancelled: false, error: deployError };
    }

    const message = getErrorMessage(error);
    deploySpinner.error(`Deploy failed${message ? `: ${message}` : "."}`);
    return { ok: false, cancelled: false, error: new Error(message) };
  }
}
