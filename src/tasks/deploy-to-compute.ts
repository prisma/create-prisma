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

type DeployFramework = "nextjs" | "hono" | "tanstack-start" | "bun";

const DEPLOY_OPTIONS_BY_TEMPLATE: Partial<
  Record<
    CreateTemplate,
    { framework: DeployFramework; httpPort?: number; requiresExplicitFramework?: boolean }
  >
> = {
  hono: { framework: "hono", httpPort: 8080 },
  elysia: { framework: "bun", httpPort: 8080, requiresExplicitFramework: true },
  next: { framework: "nextjs" },
  "tanstack-start": { framework: "tanstack-start" },
};

type AppDeployJsonResult =
  | {
      ok: true;
      result: {
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
      };
    }
  | { ok: false; error: { message?: string; summary?: string; name?: string } };

export type ComputeDeployContext = {
  template: CreateTemplate;
  packageManager: PackageManager;
  createProjectName: string;
  framework: DeployFramework;
  httpPort?: number;
  requiresExplicitFramework?: boolean;
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

function getPrismaCliAppDeployCommand(packageManager: PackageManager): string {
  return getPackageExecutionCommand(getPrismaCliExecutionPackageManager(packageManager), [
    PRISMA_CLI_PACKAGE,
    "app",
    "deploy",
  ]);
}

export function getComputeDeployScriptMap(context: ComputeDeployContext): Record<string, string> {
  const deployArgs = ["--prod", ...getComputeDeployRuntimeArgs(context)];
  const deployCommand = [getPrismaCliAppDeployCommand(context.packageManager), ...deployArgs].join(
    " ",
  );

  return {
    "compute:deploy": deployCommand,
    "compute:deploy:ci": `${deployCommand} --yes`,
  };
}

function getComputeDeployRuntimeArgs(context: ComputeDeployContext): string[] {
  return [
    ...(context.requiresExplicitFramework ? ["--framework", context.framework] : []),
    ...(context.httpPort ? ["--http-port", String(context.httpPort)] : []),
  ];
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
    requiresExplicitFramework: deployOptions.requiresExplicitFramework,
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
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(stdout) as AppDeployJsonResult;
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

export async function executeComputeDeployContext(params: {
  context: ComputeDeployContext;
  projectDir: string;
  envVars?: Record<string, string>;
}): Promise<
  { ok: true; result: ComputeDeployResult } | { ok: false; cancelled: boolean; error?: unknown }
> {
  const deploySpinner = spinner();
  deploySpinner.start("Deploying to Prisma Compute...");
  const args = [
    "app",
    "deploy",
    "--json",
    "--yes",
    "--create-project",
    params.context.createProjectName,
    ...getComputeDeployRuntimeArgs(params.context),
  ];

  try {
    for (const [key, value] of Object.entries(params.envVars ?? {})) {
      args.push("--env", `${key}=${value}`);
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
