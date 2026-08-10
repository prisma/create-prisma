import { cancel, confirm, isCancel, log, spinner } from "@clack/prompts";
import { execa } from "execa";
import path from "node:path";

import {
  isComposerDeployableTemplate,
  type CreateCommandInput,
  type CreateTemplate,
  type PackageManager,
} from "../types";
import {
  getPackageExecutionArgs,
  getRunScriptArgs,
  getRunScriptCommand,
} from "../utils/package-manager";

const PRISMA_PLATFORM_CLI = "@prisma/cli@latest";

export type ComposerDeployContext = {
  template: CreateTemplate;
  packageManager: PackageManager;
  projectName: string;
  useComposerPostgres: boolean;
};

export type ComposerDeployedService = {
  address: string;
  id: string;
  url?: string;
};

export type ComposerDeployResult = {
  appName: string;
  services: ComposerDeployedService[];
};

function hasEnvironmentValue(name: string): boolean {
  return (process.env[name] ?? "").trim().length > 0;
}

function missingComposerCredentials(): string[] {
  return ["PRISMA_SERVICE_TOKEN", "PRISMA_WORKSPACE_ID"].filter(
    (name) => !hasEnvironmentValue(name),
  );
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

type JsonEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error?: { message?: string; summary?: string } };

async function runPlatformCliJson(params: {
  context: ComposerDeployContext;
  projectDir: string;
  args: string[];
}): Promise<unknown> {
  const execution = getPackageExecutionArgs(
    params.context.packageManager,
    [PRISMA_PLATFORM_CLI, ...params.args, "--json", "--no-interactive"],
    { silent: true },
  );
  const result = await execa(execution.command, execution.args, {
    cwd: params.projectDir,
    reject: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = (() => {
    try {
      return JSON.parse(result.stdout) as JsonEnvelope;
    } catch {
      return undefined;
    }
  })();

  if (result.exitCode !== 0 || !parsed || !parsed.ok) {
    const detail =
      parsed && !parsed.ok
        ? (parsed.error?.summary ?? parsed.error?.message)
        : result.stderr || "invalid JSON output";
    throw new Error(getErrorMessage(detail));
  }

  return parsed.result;
}

function findNamedDatabase(value: unknown): { id: string; name: string } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findNamedDatabase(item);
      if (match) return match;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  if (record.name === "database" && typeof record.id === "string") {
    return { id: record.id, name: record.name };
  }

  for (const item of Object.values(record)) {
    const match = findNamedDatabase(item);
    if (match) return match;
  }
  return undefined;
}

function findDatabaseUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /^(?:prisma\+)?postgres(?:ql)?:\/\//.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findDatabaseUrl(item);
      if (match) return match;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;

  for (const item of Object.values(value)) {
    const match = findDatabaseUrl(item);
    if (match) return match;
  }
  return undefined;
}

export async function resolveComposerPostgresDatabaseUrl(params: {
  context: ComposerDeployContext;
  projectDir: string;
}): Promise<string> {
  const databases = await runPlatformCliJson({
    ...params,
    args: ["database", "list", "--project", params.context.projectName],
  });
  const database = findNamedDatabase(databases);
  if (!database) {
    throw new Error('Composer deployed, but the provisioned "database" resource was not found.');
  }

  const connection = await runPlatformCliJson({
    ...params,
    args: [
      "database",
      "connection",
      "create",
      database.id,
      "--project",
      params.context.projectName,
      "--name",
      `create-prisma-${Date.now()}`,
    ],
  });
  const databaseUrl = findDatabaseUrl(connection);
  if (!databaseUrl) {
    throw new Error("Composer database connection output did not include a connection URL.");
  }
  return databaseUrl;
}

export function getComposerDeployScriptMap(context: ComposerDeployContext): Record<string, string> {
  const steps = [
    ...(context.useComposerPostgres
      ? [getRunScriptCommand(context.packageManager, "db:migrate:deploy")]
      : []),
    getRunScriptCommand(context.packageManager, "build"),
    getRunScriptCommand(context.packageManager, "composer:deploy"),
  ];

  return {
    "composer:deploy": "prisma-composer deploy module.ts",
    deploy: steps.join(" && "),
  };
}

export async function collectComposerDeployContext(
  input: CreateCommandInput,
  options: {
    template: CreateTemplate;
    packageManager: PackageManager;
    projectName: string;
    useDefaults: boolean;
  },
): Promise<ComposerDeployContext | null | undefined> {
  if (!isComposerDeployableTemplate(options.template)) {
    if (input.deploy === true) {
      throw createExplicitDeployError(
        `${options.template} is not supported by Prisma Composer yet`,
      );
    }
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
      message: "Deploy with Prisma Composer now?",
      initialValue: false,
    });
    if (isCancel(confirmed)) {
      cancel("Operation cancelled.");
      return undefined;
    }
    wantsDeploy = confirmed;
  }

  if (!wantsDeploy) return null;

  if (options.packageManager === "deno") {
    if (input.deploy === true) {
      throw createExplicitDeployError(
        "Prisma Composer deploys require a Node.js or Bun package manager",
      );
    }
    log.warn("Prisma Composer deploys are not available for Deno projects yet.");
    return null;
  }

  const missingCredentials = missingComposerCredentials();
  if (missingCredentials.length > 0) {
    const reason = `the deploy environment is missing ${missingCredentials.join(" and ")}`;
    if (input.deploy === true) {
      throw createExplicitDeployError(reason);
    }
    log.warn(`${reason}. Skipping deployment.`);
    return null;
  }

  return {
    template: options.template,
    packageManager: options.packageManager,
    projectName: options.projectName,
    useComposerPostgres: false,
  };
}

export async function executeComposerDeployContext(params: {
  context: ComposerDeployContext;
  projectDir: string;
}): Promise<
  { ok: true; result: ComposerDeployResult } | { ok: false; cancelled: boolean; error?: unknown }
> {
  const deploySpinner = spinner();
  deploySpinner.start("Building the Composer deploy artifact...");
  const build = getRunScriptArgs(params.context.packageManager, "build");
  try {
    await execa(build.command, build.args, {
      cwd: params.projectDir,
      stdio: "pipe",
    });
    deploySpinner.stop("Composer deploy artifact built.");
  } catch (error) {
    const buildError = new Error(`Build failed: ${getErrorMessage(error)}`);
    deploySpinner.error(buildError.message);
    return { ok: false, cancelled: false, error: buildError };
  }

  log.step("Composer deploy output follows.");
  const deploy = getRunScriptArgs(params.context.packageManager, "composer:deploy");
  try {
    await execa(deploy.command, deploy.args, {
      cwd: params.projectDir,
      stdio: "inherit",
    });
    log.success("Deployed with Prisma Composer.");
    return {
      ok: true,
      result: {
        appName: params.context.projectName || path.basename(params.projectDir),
        services: [],
      },
    };
  } catch (error) {
    const deployError = new Error(getErrorMessage(error));
    log.error(`Deploy failed: ${deployError.message}`);
    return { ok: false, cancelled: false, error: deployError };
  }
}
