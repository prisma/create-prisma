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

type PrismaCliEnvelope = {
  ok: boolean;
  result?: unknown;
  error?: { summary?: string; message?: string };
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

export function parsePrismaCliEnvelope(output: string): PrismaCliEnvelope {
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
      return candidate as PrismaCliEnvelope;
    } catch {
      // The CLI may print progress lines before its final JSON envelope.
    }
  }

  throw new Error("Prisma CLI returned output that is not a valid result envelope.");
}

function getPrismaCliArgs(packageManager: PackageManager, args: string[]) {
  return getPackageExecutionArgs(packageManager, [PRISMA_PLATFORM_CLI_PACKAGE, ...args]);
}

async function isAuthenticated(packageManager: PackageManager, projectDir: string) {
  const invocation = getPrismaCliArgs(packageManager, [
    "auth",
    "whoami",
    "--json",
    "--no-interactive",
  ]);
  const result = await execa(invocation.command, invocation.args, {
    cwd: projectDir,
    env: process.env,
    reject: false,
  });
  const envelope = parsePrismaCliEnvelope(result.stdout);
  if (result.exitCode !== 0 || !envelope.ok) {
    throw new Error(
      envelope.error?.summary ?? envelope.error?.message ?? "Prisma authentication check failed.",
    );
  }
  if (typeof envelope.result !== "object" || envelope.result === null) return false;
  return Reflect.get(envelope.result, "authenticated") === true;
}

async function ensureAuthentication(packageManager: PackageManager, projectDir: string) {
  if (await isAuthenticated(packageManager, projectDir)) return;

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

  if (!(await isAuthenticated(packageManager, projectDir))) {
    throw new Error("Prisma sign-in completed without an active workspace session.");
  }
}

export async function deployWithComposer(options: {
  packageManager: PackageManager;
  projectDir: string;
  verbose: boolean;
}): Promise<boolean> {
  const progress = options.verbose ? undefined : spinner();

  try {
    await ensureAuthentication(options.packageManager, options.projectDir);
    progress?.start("Deploying to Prisma...");

    const command = getRunScriptArgs(options.packageManager, "deploy");
    await execa(command.command, command.args, {
      cwd: options.projectDir,
      env: process.env,
      stdio: options.verbose ? "inherit" : "pipe",
    });

    progress?.stop("Deployed to Prisma.");
    if (options.verbose) log.success("Deployed to Prisma.");
    return true;
  } catch (error) {
    progress?.stop("Deployment failed.");
    log.error(`Deploy failed: ${getErrorMessage(error)}`);
    return false;
  }
}
