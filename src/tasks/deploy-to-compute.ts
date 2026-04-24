import { cancel, confirm, isCancel, log, select, spinner, text } from "@clack/prompts";
import { execa, type Options as ExecaOptions } from "execa";

import {
  isComputeDeployableTemplate,
  type CreateCommandInput,
  type CreateTemplate,
  type PackageManager,
} from "../types";
import { getPackageExecutionArgs, getPackageExecutionCommand } from "../utils/package-manager";

// Mirrors sdk/src/types.ts:KNOWN_REGION_IDS. Drift risk: low — region list rarely
// changes; if it does, this falls out of sync until someone updates it.
const COMPUTE_REGIONS = [
  "us-east-1",
  "us-west-1",
  "eu-west-3",
  "eu-central-1",
  "ap-northeast-1",
  "ap-southeast-1",
] as const;
const COMPUTE_CLI_PACKAGE = "@prisma/compute-cli";

type ComputeProject = {
  id: string;
  name: string;
  defaultRegion?: string;
};
type ProjectJsonResult =
  | { ok: true; data: ComputeProject }
  | { ok: false; error: { message?: string; name?: string } };
type ProjectSelection = { type: "create" } | { type: "existing"; project: ComputeProject };

export type ComputeDeployContext = {
  template: CreateTemplate;
  packageManager: PackageManager;
  projectId: string;
  serviceName: string;
  region: string;
};

export type ComputeDeployResult = {
  serviceUrl: string;
  versionUrl: string;
  serviceId: string;
  versionId: string;
  projectId: string;
  region: string;
};

function getComputeCliCommand(packageManager: PackageManager): string {
  return getPackageExecutionCommand(packageManager, [COMPUTE_CLI_PACKAGE]);
}

function runComputeCli(packageManager: PackageManager, args: string[], options: ExecaOptions = {}) {
  const execution = getPackageExecutionArgs(packageManager, [COMPUTE_CLI_PACKAGE, ...args]);
  return execa(execution.command, execution.args, options);
}

async function isAuthenticated(packageManager: PackageManager): Promise<boolean> {
  try {
    await runComputeCli(packageManager, ["projects", "list", "--json"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function ensureComputeCliAvailable(packageManager: PackageManager): Promise<boolean> {
  try {
    await runComputeCli(packageManager, ["--help"], { stdio: "pipe" });
    return true;
  } catch (error) {
    const command = getComputeCliCommand(packageManager);
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

async function fetchProjects(packageManager: PackageManager): Promise<ComputeProject[]> {
  const { stdout } = await runComputeCli(packageManager, ["projects", "list", "--json"], {
    stdio: "pipe",
  });
  if (typeof stdout !== "string") {
    throw new Error("Failed to list Compute projects: invalid command output");
  }

  const parsed = JSON.parse(stdout) as
    | { ok: true; data: ComputeProject[] }
    | { ok: false; error: { message?: string } };
  if (!parsed.ok) {
    throw new Error(parsed.error?.message ?? "Failed to list Compute projects");
  }
  return parsed.data;
}

function parseProjectJson(stdout: unknown): ProjectJsonResult | null {
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(stdout) as ProjectJsonResult;
  } catch {
    return null;
  }
}

async function createComputeProject(
  packageManager: PackageManager,
  name: string,
): Promise<ComputeProject> {
  try {
    const { stdout } = await runComputeCli(packageManager, [
      "projects",
      "create",
      "--json",
      "--name",
      name,
    ]);
    const parsed = parseProjectJson(stdout);
    if (!parsed) {
      throw new Error("Could not parse Compute project creation output.");
    }
    if (!parsed.ok) {
      throw new Error(parsed.error.message ?? "Failed to create Compute project.");
    }
    return parsed.data;
  } catch (error) {
    const parsed = parseProjectJson((error as { stdout?: unknown })?.stdout);
    if (parsed?.ok) {
      return parsed.data;
    }
    if (parsed && !parsed.ok) {
      throw new Error(redactSecrets(parsed.error.message ?? "Failed to create Compute project."));
    }
    throw new Error(getErrorMessage(error));
  }
}

async function promptForNewProjectName(defaultProjectName: string): Promise<string | undefined> {
  const projectNameInput = await text({
    message: "Compute project name",
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

async function createProjectFromPrompt(options: {
  packageManager: PackageManager;
  defaultProjectName: string;
}): Promise<ComputeProject | undefined> {
  const projectName = await promptForNewProjectName(options.defaultProjectName);
  if (!projectName) {
    return undefined;
  }

  const createSpinner = spinner();
  createSpinner.start("Creating Compute project...");
  try {
    const project = await createComputeProject(options.packageManager, projectName);
    createSpinner.stop(`Created Compute project: ${project.name} (${project.id})`);
    return project;
  } catch (error) {
    createSpinner.error(
      `Could not create Compute project${error instanceof Error ? `: ${redactSecrets(error.message)}` : "."}`,
    );
    return undefined;
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

  if (!(await ensureComputeCliAvailable(options.packageManager))) {
    if (input.deploy === true) {
      throw createExplicitDeployError("the Compute CLI is not available");
    }
    return null;
  }

  if (!(await isAuthenticated(options.packageManager))) {
    log.info("Authenticating with Prisma Compute...");
    try {
      await runComputeCli(options.packageManager, ["login"], { stdio: "inherit" });
    } catch (error) {
      log.warn(
        `Compute login was not completed${error instanceof Error ? `: ${redactSecrets(error.message)}` : "."}`,
      );
      if (input.deploy === true) {
        throw createExplicitDeployError("authentication failed", error);
      }
      return null;
    }
  }

  let projects: ComputeProject[];
  try {
    projects = await fetchProjects(options.packageManager);
  } catch (error) {
    log.warn(
      `Could not list Compute projects${error instanceof Error ? `: ${redactSecrets(error.message)}` : "."}`,
    );
    if (input.deploy === true) {
      throw createExplicitDeployError("could not list Compute projects", error);
    }
    return null;
  }

  let selectedProject: ComputeProject | undefined;
  if (projects.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: length === 1
    const only = projects[0]!;
    const shouldUseExistingProject = await confirm({
      message: `Use Compute project ${only.name}?`,
      initialValue: true,
    });
    if (isCancel(shouldUseExistingProject)) {
      cancel("Operation cancelled.");
      return undefined;
    }
    if (shouldUseExistingProject) {
      selectedProject = only;
    } else {
      selectedProject = await createProjectFromPrompt({
        packageManager: options.packageManager,
        defaultProjectName: options.defaultServiceName,
      });
    }
  } else if (projects.length > 1) {
    const sortedProjects = projects.slice().sort((a, b) => a.name.localeCompare(b.name));
    const selection = await select<ProjectSelection>({
      message: "Select Compute project",
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
    selectedProject =
      selection.type === "create"
        ? await createProjectFromPrompt({
            packageManager: options.packageManager,
            defaultProjectName: options.defaultServiceName,
          })
        : selection.project;
  } else {
    log.info("No Compute projects found.");
    selectedProject = await createProjectFromPrompt({
      packageManager: options.packageManager,
      defaultProjectName: options.defaultServiceName,
    });
  }

  if (!selectedProject) {
    if (input.deploy === true) {
      throw createExplicitDeployError("no Compute project was selected or created");
    }
    return null;
  }

  const serviceNameInput = await text({
    message: "Service name",
    placeholder: options.defaultServiceName,
    initialValue: options.defaultServiceName,
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return "Service name is required";
      }
      return undefined;
    },
  });
  if (isCancel(serviceNameInput)) {
    cancel("Operation cancelled.");
    return undefined;
  }
  const serviceName = serviceNameInput.trim();

  const region = await select<string>({
    message: "Region",
    initialValue: selectedProject?.defaultRegion ?? COMPUTE_REGIONS[0],
    options: COMPUTE_REGIONS.map((id) => ({ value: id, label: id })),
  });
  if (isCancel(region)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return {
    template: options.template,
    packageManager: options.packageManager,
    projectId: selectedProject.id,
    serviceName,
    region,
  };
}

type DeployJsonOk = {
  ok: true;
  data: {
    projectId: string;
    serviceId: string;
    serviceName: string;
    region: string;
    versionId: string;
    versionEndpointDomain: string;
    serviceEndpointDomain: string | null;
  };
};

type DeployJsonErr = {
  ok: false;
  error: { message?: string; name?: string };
};

type DeployJsonResult = DeployJsonOk | DeployJsonErr;

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

function parseDeployJson(stdout: unknown): DeployJsonResult | null {
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(stdout) as DeployJsonResult;
  } catch {
    return null;
  }
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

function toUrl(domainOrUrl: string): string {
  return /^https?:\/\//.test(domainOrUrl) ? domainOrUrl : `https://${domainOrUrl}`;
}

function toComputeDeployResult(data: DeployJsonOk["data"]): ComputeDeployResult {
  const serviceDomain = data.serviceEndpointDomain ?? data.versionEndpointDomain;
  return {
    serviceUrl: toUrl(serviceDomain),
    versionUrl: toUrl(data.versionEndpointDomain),
    serviceId: data.serviceId,
    versionId: data.versionId,
    projectId: data.projectId,
    region: data.region,
  };
}

export async function executeComputeDeployContext(params: {
  context: ComputeDeployContext;
  projectDir: string;
  envFilePath?: string;
  envVars?: Record<string, string>;
}): Promise<
  { ok: true; result: ComputeDeployResult } | { ok: false; cancelled: boolean; error?: unknown }
> {
  const args = [
    "deploy",
    "--json",
    "--project",
    params.context.projectId,
    "--service-name",
    params.context.serviceName,
    "--region",
    params.context.region,
  ];

  if (params.envFilePath) {
    args.push("--env", params.envFilePath);
  }

  for (const [key, value] of Object.entries(params.envVars ?? {})) {
    args.push("--env", `${key}=${value}`);
  }

  const deploySpinner = spinner();
  deploySpinner.start("Deploying to Prisma Compute...");

  try {
    const { stdout, exitCode } = await runComputeCli(params.context.packageManager, args, {
      cwd: params.projectDir,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const parsed = parseDeployJson(stdout);
    if (!parsed) {
      deploySpinner.error("Deploy failed: could not parse compute deploy output.");
      return { ok: false, cancelled: false, error: new Error("Invalid compute deploy output") };
    }

    if (exitCode !== 0 || !parsed.ok) {
      const error = createDeployError(parsed.ok ? "Compute deploy failed." : parsed.error.message);
      deploySpinner.error(`Deploy failed: ${error.message}`);
      return { ok: false, cancelled: false, error };
    }

    deploySpinner.stop("Deployed to Prisma Compute.");
    return {
      ok: true,
      result: toComputeDeployResult(parsed.data),
    };
  } catch (error) {
    const parsed = parseDeployJson((error as { stdout?: unknown })?.stdout);
    if (parsed?.ok) {
      deploySpinner.stop("Deployed to Prisma Compute.");
      return {
        ok: true,
        result: toComputeDeployResult(parsed.data),
      };
    }

    if (parsed && !parsed.ok) {
      const deployError = createDeployError(parsed.error.message);
      deploySpinner.error(`Deploy failed: ${deployError.message}`);
      return { ok: false, cancelled: false, error: deployError };
    }

    const message = getErrorMessage(error);
    deploySpinner.error(`Deploy failed${message ? `: ${message}` : "."}`);
    return { ok: false, cancelled: false, error: new Error(message) };
  }
}
