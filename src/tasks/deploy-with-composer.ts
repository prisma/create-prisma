import { cancel, confirm, isCancel, log, spinner } from "@clack/prompts";
import { execa } from "execa";

import {
  type CreateCommandInput,
  type CreateTemplate,
  type DatabaseProvider,
  type PackageManager,
} from "../types";
import { prismaPlatformCliPackage } from "../constants/dependencies";
import {
  getPackageExecutionArgs,
  getPackageExecutionCommand,
  getRunScriptArgs,
  getRunScriptCommand,
} from "../utils/package-manager";

export type ComposerDeployContext = {
  template: CreateTemplate;
  packageManager: PackageManager;
  projectName: string;
  useComposerPostgres: boolean;
  verbose: boolean;
};

export type ComposerDeployResult = {
  appName: string;
};

export type PrismaCliEnvelope = {
  ok: boolean;
  result?: unknown;
  error?: { summary?: string; message?: string };
};

function redactSecrets(message: string): string {
  return message
    .replace(/\b((?:prisma\+)?postgres(?:ql)?:\/\/)[^\s'"]+/gi, "$1<redacted>")
    .replace(
      /(['"])([A-Z0-9_]*(?:DATABASE_URL|DIRECT_URL|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*=)(.*?)\1/g,
      "$1$2<redacted>$1",
    )
    .replace(
      /\b([A-Z0-9_]*(?:DATABASE_URL|DIRECT_URL|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*=)[^\s]+/g,
      "$1<redacted>",
    );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    const summary = Reflect.get(error, "summary");
    if (typeof summary === "string") return redactSecrets(summary);
    if (typeof message === "string") return redactSecrets(message);
  }

  return redactSecrets(String(error));
}

function createExplicitDeployError(reason: string, error?: unknown): Error {
  const detail = error === undefined ? "" : `: ${getErrorMessage(error)}`;
  return new Error(`Deploy requested but ${reason}${detail}`);
}

export function parsePrismaCliEnvelope(output: string): PrismaCliEnvelope {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const candidate = record.kind === "result" ? record.envelope : parsed;
    if (typeof candidate !== "object" || candidate === null) continue;
    const envelope = candidate as Record<string, unknown>;
    if (typeof envelope.ok !== "boolean") continue;
    return envelope as PrismaCliEnvelope;
  }

  throw new Error("Prisma CLI returned output that is not a valid result envelope.");
}

function getPrismaPlatformCliArgs(
  packageManager: PackageManager,
  args: string[],
): { command: string; args: string[] } {
  return getPackageExecutionArgs(packageManager, [prismaPlatformCliPackage, ...args], {
    silent: true,
  });
}

function getPrismaAuthLoginCommand(packageManager: PackageManager): string {
  return getPackageExecutionCommand(packageManager, [prismaPlatformCliPackage, "auth", "login"], {
    silent: true,
  });
}

async function isAuthenticatedWithPrisma(
  packageManager: PackageManager,
  projectDir: string,
): Promise<boolean> {
  const invocation = getPrismaPlatformCliArgs(packageManager, [
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
  let envelope: PrismaCliEnvelope;
  try {
    envelope = parsePrismaCliEnvelope(result.stdout);
  } catch (error) {
    const detail = result.stderr.trim() || result.stdout.trim() || getErrorMessage(error);
    throw new Error(redactSecrets(detail));
  }
  if (result.exitCode !== 0 || !envelope.ok) {
    throw new Error(
      envelope.error?.summary ??
        envelope.error?.message ??
        (result.stderr.trim() || "Prisma authentication check failed."),
    );
  }
  if (typeof envelope.result !== "object" || envelope.result === null) {
    throw new Error("Prisma CLI authentication output did not include a result.");
  }
  const authenticated = Reflect.get(envelope.result, "authenticated");
  if (typeof authenticated !== "boolean") {
    throw new Error("Prisma CLI authentication output did not include an authentication status.");
  }
  return authenticated;
}

async function ensurePrismaAuthentication(
  packageManager: PackageManager,
  projectDir: string,
): Promise<void> {
  if (await isAuthenticatedWithPrisma(packageManager, projectDir)) return;

  if (process.stdin.isTTY !== true) {
    throw new Error(
      `Prisma authentication is required. Run ${getPrismaAuthLoginCommand(packageManager)} in an interactive terminal, then ${getRunScriptCommand(packageManager, "deploy")}. For CI, set PRISMA_SERVICE_TOKEN.`,
    );
  }

  log.info("Sign in to Prisma to deploy.");
  const login = getPrismaPlatformCliArgs(packageManager, ["auth", "login"]);
  await execa(login.command, login.args, {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });

  if (!(await isAuthenticatedWithPrisma(packageManager, projectDir))) {
    throw new Error("Prisma sign-in completed without an active workspace session.");
  }
}

export function getComposerDeployScriptMap(context: ComposerDeployContext): Record<string, string> {
  const steps = [
    getRunScriptCommand(context.packageManager, "build"),
    getRunScriptCommand(context.packageManager, "composer:deploy"),
    ...(context.useComposerPostgres
      ? [getRunScriptCommand(context.packageManager, "composer:database:setup")]
      : []),
  ];

  return {
    "composer:deploy": getPackageExecutionCommand(
      context.packageManager,
      [prismaPlatformCliPackage, "composer", "deploy", "module.ts"],
      { silent: true },
    ),
    ...(context.useComposerPostgres
      ? {
          "composer:database:setup": `${
            context.packageManager === "bun" ? "bun" : "node"
          } scripts/setup-composer-postgres.mjs`,
        }
      : {}),
    deploy: steps.join(" && "),
  };
}

export async function collectComposerDeployContext(
  input: CreateCommandInput,
  options: {
    template: CreateTemplate;
    databaseProvider: DatabaseProvider;
    packageManager: PackageManager;
    projectName: string;
    useDefaults: boolean;
    verbose: boolean;
  },
): Promise<ComposerDeployContext | null | undefined> {
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
      message: "Deploy to Prisma now?",
      initialValue: false,
    });
    if (isCancel(confirmed)) {
      cancel("Operation cancelled.");
      return undefined;
    }
    wantsDeploy = confirmed;
  }

  if (!wantsDeploy) return null;

  if (
    options.databaseProvider !== "postgresql" &&
    (process.env.DATABASE_URL ?? "").trim().length === 0
  ) {
    const reason = `immediate deployment for ${options.databaseProvider} needs DATABASE_URL`;
    if (input.deploy === true) {
      throw createExplicitDeployError(reason);
    }
    log.warn(
      `${reason}. ` +
        "Scaffolding without deployment; configure the generated .env file and run the deploy script later.",
    );
    return null;
  }

  return {
    template: options.template,
    packageManager: options.packageManager,
    projectName: options.projectName,
    useComposerPostgres: false,
    verbose: options.verbose,
  };
}

export async function executeComposerDeployContext(params: {
  context: ComposerDeployContext;
  projectDir: string;
}): Promise<
  { ok: true; result: ComposerDeployResult } | { ok: false; cancelled: boolean; error?: unknown }
> {
  const deploy = getRunScriptArgs(params.context.packageManager, "deploy");
  const deploySpinner = params.context.verbose ? undefined : spinner();
  let deployStarted = false;
  try {
    await ensurePrismaAuthentication(params.context.packageManager, params.projectDir);
    if (params.context.verbose) {
      log.step("Prisma deployment output follows.");
    } else {
      deploySpinner?.start("Deploying to Prisma...");
      deployStarted = true;
    }
    await execa(deploy.command, deploy.args, {
      cwd: params.projectDir,
      env: process.env,
      stdio: params.context.verbose ? "inherit" : "pipe",
    });
    if (params.context.verbose) {
      log.success("Deployed to Prisma.");
    } else {
      deploySpinner?.stop("Deployed to Prisma.");
    }
    return {
      ok: true,
      result: {
        appName: params.context.projectName,
      },
    };
  } catch (error) {
    if (deployStarted) {
      deploySpinner?.stop("Deployment failed.");
    }
    const deployError = new Error(getErrorMessage(error));
    log.error(`Deploy failed: ${deployError.message}`);
    return { ok: false, cancelled: false, error: deployError };
  }
}
