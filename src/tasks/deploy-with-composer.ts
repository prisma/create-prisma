import { cancel, isCancel, log, select, spinner, taskLog } from "@clack/prompts";
import { execa } from "execa";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

import { PRISMA_PLATFORM_CLI_PACKAGE } from "../constants/dependencies";
import type { PackageManager } from "../types";
import { getErrorMessage, redactSecrets } from "../utils/errors";
import {
  getPackageExecutionArgs,
  getPackageExecutionCommand,
  getRunScriptArgs,
  getRunScriptCommand,
} from "../utils/package-manager";
import { runSetupCommand } from "../utils/run-command";

type PrismaCliEnvelope<Result = unknown> = {
  ok: boolean;
  result?: Result;
  error?: { summary?: string; message?: string; why?: string };
};

type PrismaWorkspace = {
  id: string;
  name: string | null;
};

type WhoamiResult = {
  authenticated: boolean;
  workspace: PrismaWorkspace | null;
  source: "stored" | "environment" | null;
};

type WorkspaceListResult = {
  items: Array<{
    workspaceId: string;
    workspaceName: string | null;
    current: boolean;
  }>;
};

type WorkspaceUseResult = {
  workspace: PrismaWorkspace;
};

type ProjectShowResult = {
  workspace: PrismaWorkspace;
  project: { id: string; name: string } | null;
};

type ProjectListResult = {
  items: Array<{
    id: string;
    name: string;
  }>;
};

type ComposerDeployCommandResult = {
  summary: {
    app: string;
    nodes: Array<{
      entities: Array<{ kind: string; id: string; url?: string }>;
    }>;
  } | null;
};

export type ComposerDeployResult = {
  appName: string;
  appUrl?: string;
  serviceId?: string;
  workspace?: PrismaWorkspace;
  project: {
    id?: string;
    name: string;
    consoleUrl?: string;
  };
};

function stripResourcePrefix(id: string, prefix: "proj" | "wksp"): string {
  const marker = `${prefix}_`;
  return id.startsWith(marker) ? id.slice(marker.length) : id;
}

export function getConsoleProjectUrl(workspaceId: string, projectId: string): string {
  const consoleWorkspaceId = stripResourcePrefix(workspaceId, "wksp");
  const consoleProjectId = stripResourcePrefix(projectId, "proj");
  return `https://console.prisma.io/${encodeURIComponent(
    consoleWorkspaceId,
  )}/${encodeURIComponent(consoleProjectId)}`;
}

export function parsePrismaCliEnvelope<Result = unknown>(
  output: string,
): PrismaCliEnvelope<Result> {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const candidate = parsed.kind === "result" ? parsed.envelope : parsed;
      if (typeof candidate !== "object" || candidate === null) continue;
      if (typeof Reflect.get(candidate, "ok") !== "boolean") continue;
      return candidate as PrismaCliEnvelope<Result>;
    } catch {
      // The CLI may print progress frames before its final JSON envelope.
    }
  }

  throw new Error("Prisma CLI returned output that is not a valid result envelope.");
}

function getPrismaCliArgs(packageManager: PackageManager, args: string[]) {
  return getPackageExecutionArgs(packageManager, [PRISMA_PLATFORM_CLI_PACKAGE, ...args]);
}

async function runPrismaJsonCommand<Result>(options: {
  packageManager: PackageManager;
  projectDir: string;
  args: string[];
  onStderrLine?: (line: string) => void;
}): Promise<Result> {
  const invocation = getPrismaCliArgs(options.packageManager, [
    ...options.args,
    "--json",
    "--no-interactive",
  ]);
  const subprocess = execa(invocation.command, invocation.args, {
    cwd: options.projectDir,
    env: process.env,
    reject: false,
  });
  const stderrLines =
    options.onStderrLine && subprocess.stderr
      ? (async () => {
          const lines = createInterface({ input: subprocess.stderr });
          for await (const line of lines) {
            if (line.trim()) options.onStderrLine?.(line);
          }
        })()
      : Promise.resolve();
  const [result] = await Promise.all([subprocess, stderrLines]);

  let envelope: PrismaCliEnvelope<Result>;
  try {
    envelope = parsePrismaCliEnvelope<Result>(result.stdout);
  } catch (error) {
    if (result.exitCode !== 0 && result.stderr.trim()) throw new Error(result.stderr.trim());
    throw error;
  }

  if (result.exitCode !== 0 || !envelope.ok || envelope.result === undefined) {
    const summary = envelope.error?.summary ?? envelope.error?.message;
    throw new Error(
      [summary, envelope.error?.why].filter(Boolean).join(": ") ||
        result.stderr.trim() ||
        "Prisma CLI command failed.",
    );
  }
  return envelope.result;
}

export function findProjectNameCollisions(
  projects: ProjectListResult["items"],
  appName: string,
): ProjectListResult["items"] {
  return projects.filter((project) => project.name === appName);
}

async function ensureProjectNameAvailable(options: {
  appName: string;
  packageManager: PackageManager;
  projectDir: string;
  workspace: PrismaWorkspace;
}): Promise<void> {
  const result = await runPrismaJsonCommand<ProjectListResult>({
    packageManager: options.packageManager,
    projectDir: options.projectDir,
    args: ["project", "list"],
  });
  const collisions = findProjectNameCollisions(result.items, options.appName);
  if (collisions.length === 0) return;

  const projectIds = collisions.map((project) => project.id).join(", ");
  throw new Error(
    `A Prisma project named "${options.appName}" already exists in workspace ${workspaceLabel(
      options.workspace,
    )} (${options.workspace.id}). Choose a different project name or delete the existing project ` +
      `(${projectIds}) in Prisma Console, then retry.`,
  );
}

async function ensureAuthentication(options: {
  packageManager: PackageManager;
  projectDir: string;
  output: Writable;
  allowInteractiveLogin: boolean;
  beforeInteractiveLogin?: () => void;
}): Promise<WhoamiResult> {
  const whoami = () =>
    runPrismaJsonCommand<WhoamiResult>({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      args: ["auth", "whoami"],
    });

  const authState = await whoami();
  if (authState.authenticated) return authState;

  const loginCommand = getPackageExecutionCommand(options.packageManager, [
    PRISMA_PLATFORM_CLI_PACKAGE,
    "auth",
    "login",
  ]);
  if (!options.allowInteractiveLogin || process.stdin.isTTY !== true) {
    throw new Error(
      `Sign in first with ${loginCommand}, then run ${getRunScriptCommand(options.packageManager, "deploy")}.`,
    );
  }

  options.beforeInteractiveLogin?.();
  log.info("Sign in to Prisma to deploy.", { output: options.output });
  const login = getPrismaCliArgs(options.packageManager, ["auth", "login"]);
  await execa(login.command, login.args, {
    cwd: options.projectDir,
    env: process.env,
    stdio: "inherit",
  });

  const authenticatedState = await whoami();
  if (!authenticatedState.authenticated) {
    throw new Error("Prisma sign-in completed without an active workspace session.");
  }
  return authenticatedState;
}

function workspaceLabel(workspace: PrismaWorkspace): string {
  return workspace.name ?? workspace.id;
}

async function useWorkspace(options: {
  packageManager: PackageManager;
  projectDir: string;
  workspace: string;
}): Promise<PrismaWorkspace> {
  const result = await runPrismaJsonCommand<WorkspaceUseResult>({
    packageManager: options.packageManager,
    projectDir: options.projectDir,
    args: ["auth", "workspace", "use", options.workspace],
  });
  return result.workspace;
}

async function selectDeploymentWorkspace(options: {
  packageManager: PackageManager;
  projectDir: string;
  shouldPrompt: boolean;
  workspace?: string;
  authState: WhoamiResult;
  beforePrompt?: () => void;
  afterPrompt?: () => void;
  output: Writable;
}): Promise<PrismaWorkspace | undefined> {
  const activeWorkspace = options.authState.workspace;
  if (!activeWorkspace) {
    throw new Error("The active Prisma credential does not specify a workspace.");
  }

  if (options.workspace) {
    if (options.authState.source === "environment") {
      if (options.workspace === activeWorkspace.id || options.workspace === activeWorkspace.name) {
        return activeWorkspace;
      }
      throw new Error(
        `The environment credential is fixed to workspace ${workspaceLabel(
          activeWorkspace,
        )}. Unset it before using --workspace ${options.workspace}.`,
      );
    }
    return useWorkspace({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      workspace: options.workspace,
    });
  }

  if (!options.shouldPrompt || process.stdin.isTTY !== true) return activeWorkspace;

  const available = await runPrismaJsonCommand<WorkspaceListResult>({
    packageManager: options.packageManager,
    projectDir: options.projectDir,
    args: ["auth", "workspace", "list"],
  });
  if (available.items.length <= 1) return activeWorkspace;

  options.beforePrompt?.();
  const selectedWorkspaceId = await select({
    message: "Select Prisma workspace for deployment",
    initialValue: activeWorkspace.id,
    options: available.items.map((workspace) => ({
      value: workspace.workspaceId,
      label: workspace.workspaceName ?? workspace.workspaceId,
      hint: workspace.current ? `${workspace.workspaceId}, current` : workspace.workspaceId,
    })),
    output: options.output,
  });
  if (isCancel(selectedWorkspaceId)) {
    cancel("Operation cancelled.", { output: options.output });
    return;
  }
  options.afterPrompt?.();
  if (selectedWorkspaceId === activeWorkspace.id) return activeWorkspace;

  return useWorkspace({
    packageManager: options.packageManager,
    projectDir: options.projectDir,
    workspace: selectedWorkspaceId,
  });
}

export function parseComposerDeployResult(result: ComposerDeployCommandResult):
  | {
      appName: string;
      appUrl?: string;
      serviceId?: string;
    }
  | undefined {
  const summary = result.summary;
  if (!summary) return;
  const computeService = summary.nodes
    .flatMap((node) => node.entities)
    .find((entity) => entity.kind === "compute-service");
  return {
    appName: summary.app,
    ...(computeService?.id ? { serviceId: computeService.id } : {}),
    ...(computeService?.url ? { appUrl: computeService.url.replace(/\/$/, "") } : {}),
  };
}

async function getProjectDetails(options: {
  packageManager: PackageManager;
  projectDir: string;
  appName: string;
}): Promise<Pick<ComposerDeployResult, "workspace" | "project"> | undefined> {
  try {
    const result = await runPrismaJsonCommand<ProjectShowResult>({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      args: ["project", "show", options.appName],
    });
    if (!result.project) return;
    return {
      workspace: result.workspace,
      project: {
        id: result.project.id,
        name: result.project.name,
        consoleUrl: getConsoleProjectUrl(result.workspace.id, result.project.id),
      },
    };
  } catch {
    // Metadata enrichment must not turn a successful deploy into a failure.
    return;
  }
}

/**
 * Performs the optional one-shot deployment at the end of a create-prisma scaffold.
 * Generated projects use their own `deploy` script for every subsequent deployment.
 */
export async function deployNewProjectWithComposer(options: {
  appName: string;
  packageManager: PackageManager;
  projectDir: string;
  shouldPromptForWorkspace: boolean;
  verbose: boolean;
  output?: Writable;
  allowInteractiveLogin?: boolean;
  json?: boolean;
  throwOnError?: boolean;
  workspace?: string;
}): Promise<ComposerDeployResult | undefined> {
  const output = options.output ?? process.stdout;
  const progress = options.verbose ? undefined : spinner({ output });
  let deploymentLog: ReturnType<typeof taskLog> | undefined;
  let progressRunning = false;
  const showProgress = (message: string) => {
    if (!progress) return;
    if (progressRunning) {
      progress.message(message);
    } else {
      progress.start(message);
      progressRunning = true;
    }
  };
  const clearProgress = () => {
    if (!progress || !progressRunning) return;
    progress.clear();
    progressRunning = false;
  };

  try {
    showProgress("Checking Prisma account...");
    if (options.verbose) log.step("Checking Prisma account.", { output });
    const authState = await ensureAuthentication({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      output,
      allowInteractiveLogin: options.allowInteractiveLogin ?? true,
      beforeInteractiveLogin: clearProgress,
    });

    showProgress("Checking Prisma workspace...");
    if (options.verbose) log.step("Checking Prisma workspace.", { output });
    const selectedWorkspace = await selectDeploymentWorkspace({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      shouldPrompt: options.shouldPromptForWorkspace,
      authState,
      output,
      beforePrompt: clearProgress,
      afterPrompt: () => showProgress("Selecting Prisma workspace..."),
      ...(options.workspace ? { workspace: options.workspace } : {}),
    });
    if (!selectedWorkspace) return;

    showProgress("Checking Prisma project name...");
    if (options.verbose) log.step("Checking Prisma project name.", { output });
    await ensureProjectNameAvailable({
      appName: options.appName,
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      workspace: selectedWorkspace,
    });

    showProgress("Building for deployment...");
    if (options.verbose) log.step("Building for deployment.", { output });
    const build = getRunScriptArgs(options.packageManager, "build");
    await runSetupCommand({
      command: build.command,
      args: build.args,
      cwd: options.projectDir,
      env: process.env,
      verbose: options.verbose,
      json: options.json === true,
    });

    clearProgress();
    const deployCommand = getPackageExecutionCommand(options.packageManager, [
      PRISMA_PLATFORM_CLI_PACKAGE,
      "deploy",
      "module.ts",
    ]);
    if (options.verbose) {
      log.step(`Deploying to Prisma with ${deployCommand}.`, { output });
    } else {
      deploymentLog = taskLog({ title: "Deploying to Prisma...", limit: 10, output });
      deploymentLog.message(`$ ${deployCommand}`);
    }
    const deployment = parseComposerDeployResult(
      await runPrismaJsonCommand<ComposerDeployCommandResult>({
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        args: ["deploy", "module.ts"],
        onStderrLine: (line) => {
          const redactedLine = redactSecrets(line);
          if (options.verbose) {
            output.write(`${redactedLine}\n`);
          } else {
            deploymentLog?.message(redactedLine);
          }
        },
      }),
    );
    const appName = deployment?.appName ?? options.appName;

    if (options.verbose) {
      log.step("Loading deployment details.", { output });
    } else {
      deploymentLog?.message("Loading deployment details...");
    }
    const details = await getProjectDetails({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      appName,
    });

    deploymentLog?.success("Deployed to Prisma.");
    deploymentLog = undefined;
    progressRunning = false;
    if (options.verbose) log.success("Deployed to Prisma.", { output });
    const workspace = details?.workspace ?? selectedWorkspace;
    return {
      appName,
      ...(deployment?.appUrl ? { appUrl: deployment.appUrl } : {}),
      ...(deployment?.serviceId ? { serviceId: deployment.serviceId } : {}),
      ...(workspace ? { workspace } : {}),
      project: details?.project ?? { name: appName },
    };
  } catch (error) {
    if (deploymentLog) {
      deploymentLog.error("Deployment failed.");
      deploymentLog = undefined;
    } else {
      progress?.error("Deployment failed.");
    }
    progressRunning = false;
    log.error(`Deploy failed: ${getErrorMessage(error)}`, { output });
    if (options.throwOnError) throw error;
    return;
  }
}
