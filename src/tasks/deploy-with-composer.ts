import { log, spinner } from "@clack/prompts";
import { execa } from "execa";

import { PRISMA_PLATFORM_CLI_PACKAGE } from "../constants/dependencies";
import type { PackageManager } from "../types";
import {
  getPackageExecutionArgs,
  getPackageExecutionCommand,
  getRunScriptArgs,
  getRunScriptCommand,
} from "../utils/package-manager";

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
};

type ProjectShowResult = {
  workspace: PrismaWorkspace;
  project: { id: string; name: string } | null;
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
  workspace?: PrismaWorkspace;
  project: {
    id?: string;
    name: string;
    consoleUrl?: string;
  };
};

function redactSecrets(message: string): string {
  return message
    .replace(/\b((?:prisma\+)?postgres(?:ql)?:\/\/)[^\s'"]+/gi, "$1<redacted>")
    .replace(
      /\b([A-Z0-9_]*(?:DATABASE_URL|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*=)[^\s]+/g,
      "$1<redacted>",
    );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return redactSecrets(String(error));
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
  forwardStderr?: boolean;
}): Promise<Result> {
  const invocation = getPrismaCliArgs(options.packageManager, [
    ...options.args,
    "--json",
    "--no-interactive",
  ]);
  const result = await execa(invocation.command, invocation.args, {
    cwd: options.projectDir,
    env: process.env,
    reject: false,
  });

  if (options.forwardStderr && result.stderr) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }

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

async function ensureAuthentication(
  packageManager: PackageManager,
  projectDir: string,
): Promise<WhoamiResult> {
  const whoami = () =>
    runPrismaJsonCommand<WhoamiResult>({
      packageManager,
      projectDir,
      args: ["auth", "whoami"],
    });

  const authState = await whoami();
  if (authState.authenticated) return authState;

  const loginCommand = getPackageExecutionCommand(packageManager, [
    PRISMA_PLATFORM_CLI_PACKAGE,
    "auth",
    "login",
  ]);
  if (process.stdin.isTTY !== true) {
    throw new Error(
      `Sign in first with ${loginCommand}, then run ${getRunScriptCommand(packageManager, "deploy")}.`,
    );
  }

  log.info("Sign in to Prisma to deploy.");
  const login = getPrismaCliArgs(packageManager, ["auth", "login"]);
  await execa(login.command, login.args, {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });

  const authenticatedState = await whoami();
  if (!authenticatedState.authenticated) {
    throw new Error("Prisma sign-in completed without an active workspace session.");
  }
  return authenticatedState;
}

export function parseComposerDeployResult(result: ComposerDeployCommandResult):
  | {
      appName: string;
      appUrl?: string;
    }
  | undefined {
  const summary = result.summary;
  if (!summary) return;
  const computeService = summary.nodes
    .flatMap((node) => node.entities)
    .find((entity) => entity.kind === "compute-service");
  return {
    appName: summary.app,
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
      args: ["project", "show", "--project", options.appName],
    });
    if (!result.project) return;
    return {
      workspace: result.workspace,
      project: {
        id: result.project.id,
        name: result.project.name,
        consoleUrl: `https://console.prisma.io/${encodeURIComponent(
          result.workspace.id,
        )}/${encodeURIComponent(result.project.id)}`,
      },
    };
  } catch {
    // Metadata enrichment must not turn a successful deploy into a failure.
    return;
  }
}

export async function deployWithComposer(options: {
  appName: string;
  packageManager: PackageManager;
  projectDir: string;
  verbose: boolean;
}): Promise<ComposerDeployResult | undefined> {
  const progress = options.verbose ? undefined : spinner();

  try {
    const authState = await ensureAuthentication(options.packageManager, options.projectDir);

    progress?.start("Building for deployment...");
    if (options.verbose) log.step("Building for deployment.");
    const build = getRunScriptArgs(options.packageManager, "build");
    await execa(build.command, build.args, {
      cwd: options.projectDir,
      env: process.env,
      stdio: options.verbose ? "inherit" : "pipe",
    });

    progress?.message("Deploying to Prisma...");
    if (options.verbose) log.step("Deploying to Prisma.");
    const deployment = parseComposerDeployResult(
      await runPrismaJsonCommand<ComposerDeployCommandResult>({
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        args: ["composer", "deploy", "module.ts"],
        forwardStderr: options.verbose,
      }),
    );
    const appName = deployment?.appName ?? options.appName;

    progress?.message("Loading deployment details...");
    const details = await getProjectDetails({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      appName,
    });

    progress?.stop("Deployed to Prisma.");
    if (options.verbose) log.success("Deployed to Prisma.");
    const workspace = details?.workspace ?? authState.workspace ?? undefined;
    return {
      appName,
      ...(deployment?.appUrl ? { appUrl: deployment.appUrl } : {}),
      ...(workspace ? { workspace } : {}),
      project: details?.project ?? { name: appName },
    };
  } catch (error) {
    progress?.error("Deployment failed.");
    log.error(`Deploy failed: ${getErrorMessage(error)}`);
    return;
  }
}
