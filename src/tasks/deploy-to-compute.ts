import { cancel, confirm, isCancel, log, select, spinner, text } from "@clack/prompts";
import { execa } from "execa";

import {
  isComputeDeployableTemplate,
  type CreateCommandInput,
  type CreateTemplate,
} from "../types";

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

type ComputeProject = {
  id: string;
  name: string;
  defaultRegion?: string;
};

export type ComputeDeployContext = {
  template: CreateTemplate;
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

async function isAuthenticated(): Promise<boolean> {
  if (process.env.PRISMA_API_TOKEN && process.env.PRISMA_API_TOKEN.trim().length > 0) {
    return true;
  }

  try {
    await execa("compute", ["projects", "list", "--json"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function ensureComputeOnPath(): Promise<boolean> {
  try {
    await execa("compute", ["--help"], { stdio: "pipe" });
    return true;
  } catch (error) {
    const isMissing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";
    if (isMissing) {
      log.warn(
        "`compute` CLI not found on PATH. Install with `bun link` (local dev) or `npm i -g @prisma/compute-cli`, then re-run.",
      );
      return false;
    }
    return true; // non-ENOENT — assume present, let later calls fail with their own messages
  }
}

async function fetchProjects(): Promise<ComputeProject[]> {
  const { stdout } = await execa("compute", ["projects", "list", "--json"], {
    stdio: "pipe",
  });
  const parsed = JSON.parse(stdout) as
    | { ok: true; data: ComputeProject[] }
    | { ok: false; error: { message?: string } };
  if (!parsed.ok) {
    throw new Error(parsed.error?.message ?? "Failed to list Compute projects");
  }
  return parsed.data;
}

export async function collectComputeDeployContext(
  input: CreateCommandInput,
  options: {
    template: CreateTemplate;
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

  if (!(await ensureComputeOnPath())) {
    return null;
  }

  if (!(await isAuthenticated())) {
    log.info("Authenticating with Prisma Compute...");
    try {
      await execa("compute", ["login"], { stdio: "inherit" });
    } catch (error) {
      log.warn(
        `Compute login was not completed${error instanceof Error ? `: ${error.message}` : "."}`,
      );
      return null;
    }
  }

  let projects: ComputeProject[];
  try {
    projects = await fetchProjects();
  } catch (error) {
    log.warn(
      `Could not list Compute projects${error instanceof Error ? `: ${error.message}` : "."}`,
    );
    return null;
  }

  if (projects.length === 0) {
    log.warn(
      "No Compute projects found in your workspace. Create one in the Prisma Console and try again.",
    );
    return null;
  }

  let projectId: string;
  if (projects.length === 1) {
    // biome-ignore lint/style/noNonNullAssertion: length === 1
    const only = projects[0]!;
    log.info(`Using project: ${only.name} (${only.id})`);
    projectId = only.id;
  } else {
    const selection = await select<string>({
      message: "Select Compute project",
      options: projects
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ value: p.id, label: p.name, hint: p.id })),
    });
    if (isCancel(selection)) {
      cancel("Operation cancelled.");
      return undefined;
    }
    projectId = selection;
  }

  const selectedProject = projects.find((p) => p.id === projectId);

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
    projectId,
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

export async function executeComputeDeployContext(params: {
  context: ComputeDeployContext;
  projectDir: string;
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

  for (const [key, value] of Object.entries(params.envVars ?? {})) {
    args.push("--env", `${key}=${value}`);
  }

  const deploySpinner = spinner();
  deploySpinner.start("Deploying to Prisma Compute...");

  try {
    const { stdout } = await execa("compute", args, {
      cwd: params.projectDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let parsed: DeployJsonOk | DeployJsonErr;
    try {
      parsed = JSON.parse(stdout) as DeployJsonOk | DeployJsonErr;
    } catch (parseError) {
      deploySpinner.error("Deploy failed: could not parse compute deploy output.");
      return { ok: false, cancelled: false, error: parseError };
    }

    if (!parsed.ok) {
      deploySpinner.error(`Deploy failed: ${parsed.error.message ?? "unknown error"}`);
      return { ok: false, cancelled: false, error: new Error(parsed.error.message) };
    }

    deploySpinner.stop("Deployed to Prisma Compute.");
    return {
      ok: true,
      result: {
        serviceUrl: parsed.data.serviceEndpointDomain ?? parsed.data.versionEndpointDomain,
        versionUrl: parsed.data.versionEndpointDomain,
        serviceId: parsed.data.serviceId,
        versionId: parsed.data.versionId,
        projectId: parsed.data.projectId,
        region: parsed.data.region,
      },
    };
  } catch (error) {
    deploySpinner.error(`Deploy failed${error instanceof Error ? `: ${error.message}` : "."}`);
    return { ok: false, cancelled: false, error };
  }
}
