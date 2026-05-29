import { cancel, confirm, isCancel, log, select, spinner, text } from "@clack/prompts";
import { execa, type Options as ExecaOptions } from "execa";

import {
  isComputeDeployableTemplate,
  type CreateCommandInput,
  type CreateTemplate,
  type PackageManager,
} from "../types";
import { getPackageExecutionArgs, getPackageExecutionCommand } from "../utils/package-manager";

const PRISMA_CLI_PACKAGE = "@prisma/cli@dev";

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

type ProjectListJsonResult =
  | {
      ok: true;
      result: {
        items: PrismaProject[];
      };
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

type ProjectSelection = { type: "create" } | { type: "existing"; project: PrismaProject };
type ProjectTarget =
  | { projectRef: string; createProjectName?: never }
  | { projectRef?: never; createProjectName: string };

export type ComputeDeployContext = ProjectTarget & {
  template: CreateTemplate;
  packageManager: PackageManager;
  appName: string;
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
  return getPackageExecutionCommand(packageManager, [PRISMA_CLI_PACKAGE]);
}

function runPrismaCli(packageManager: PackageManager, args: string[], options: ExecaOptions = {}) {
  const execution = getPackageExecutionArgs(packageManager, [PRISMA_CLI_PACKAGE, ...args]);
  return execa(execution.command, execution.args, options);
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

async function fetchProjects(packageManager: PackageManager): Promise<PrismaProject[]> {
  const { stdout } = await runPrismaCli(packageManager, ["project", "list", "--json"], {
    stdio: "pipe",
  });
  const parsed = parseProjectListJson(stdout);
  if (!parsed) {
    throw new Error("Failed to list Prisma projects: invalid command output");
  }
  if (!parsed.ok) {
    throw new Error(getJsonErrorMessage(parsed.error, "Failed to list Prisma projects"));
  }
  return parsed.result.items.map((project) => ({
    id: project.id,
    name: project.name,
  }));
}

function parseProjectListJson(stdout: unknown): ProjectListJsonResult | null {
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(stdout) as ProjectListJsonResult;
  } catch {
    return null;
  }
}

async function promptForNewProjectName(defaultProjectName: string): Promise<string | undefined> {
  const projectNameInput = await text({
    message: "Prisma project name",
    placeholder: defaultProjectName,
    initialValue: defaultProjectName,
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return "Project name is required";
      }
      return undefined;
    },
  });
  if (isCancel(projectNameInput)) {
    cancel("Operation cancelled.");
    return undefined;
  }
  return projectNameInput.trim();
}

async function promptForNewProjectTarget(
  defaultProjectName: string,
): Promise<ProjectTarget | undefined> {
  const projectName = await promptForNewProjectName(defaultProjectName);
  return projectName ? { createProjectName: projectName } : undefined;
}

async function collectProjectTarget(options: {
  packageManager: PackageManager;
  defaultProjectName: string;
}): Promise<ProjectTarget | undefined> {
  const projects = await fetchProjects(options.packageManager);

  if (projects.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: length === 1
    const only = projects[0]!;
    const shouldUseExistingProject = await confirm({
      message: `Use Prisma project ${only.name}?`,
      initialValue: true,
    });
    if (isCancel(shouldUseExistingProject)) {
      cancel("Operation cancelled.");
      return undefined;
    }
    return shouldUseExistingProject
      ? { projectRef: only.id }
      : promptForNewProjectTarget(options.defaultProjectName);
  }

  if (projects.length > 1) {
    const sortedProjects = projects.slice().sort((a, b) => a.name.localeCompare(b.name));
    const selection = await select<ProjectSelection>({
      message: "Select Prisma project",
      options: [
        { value: { type: "create" }, label: "Create new project" },
        ...sortedProjects.map((project) => ({
          value: { type: "existing" as const, project },
          label: project.name,
          hint: project.id,
        })),
      ],
    });
    if (isCancel(selection)) {
      cancel("Operation cancelled.");
      return undefined;
    }
    return selection.type === "create"
      ? promptForNewProjectTarget(options.defaultProjectName)
      : { projectRef: selection.project.id };
  }

  log.info("No Prisma projects found.");
  return promptForNewProjectTarget(options.defaultProjectName);
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

  let projectTarget: ProjectTarget | undefined;
  try {
    projectTarget = await collectProjectTarget({
      packageManager: options.packageManager,
      defaultProjectName: options.defaultServiceName,
    });
  } catch (error) {
    log.warn(
      `Could not list Prisma projects${error instanceof Error ? `: ${redactSecrets(error.message)}` : "."}`,
    );
    if (input.deploy === true) {
      throw createExplicitDeployError("could not list Prisma projects", error);
    }
    return null;
  }

  if (!projectTarget) {
    if (input.deploy === true) {
      throw createExplicitDeployError("no Prisma project was selected or created");
    }
    return null;
  }

  const appNameInput = await text({
    message: "App name",
    placeholder: options.defaultServiceName,
    initialValue: options.defaultServiceName,
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return "App name is required";
      }
      return undefined;
    },
  });
  if (isCancel(appNameInput)) {
    cancel("Operation cancelled.");
    return undefined;
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
    ...projectTarget,
    template: options.template,
    packageManager: options.packageManager,
    appName: appNameInput.trim(),
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
  const args = [
    "app",
    "deploy",
    "--json",
    "--yes",
    "--app",
    params.context.appName,
    "--framework",
    params.context.framework,
  ];

  if (params.context.projectRef) {
    args.push("--project", params.context.projectRef);
  } else if (params.context.createProjectName) {
    args.push("--create-project", params.context.createProjectName);
  } else {
    const error = new Error("Deploy target is missing a Prisma project.");
    return { ok: false, cancelled: false, error };
  }

  if (params.context.httpPort) {
    args.push("--http-port", String(params.context.httpPort));
  }

  for (const [key, value] of Object.entries(params.envVars ?? {})) {
    args.push("--env", `${key}=${value}`);
  }

  const deploySpinner = spinner();
  deploySpinner.start("Deploying to Prisma Compute...");

  try {
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
