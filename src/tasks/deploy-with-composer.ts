import { cancel, confirm, isCancel, log } from "@clack/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import {
  type CreateCommandInput,
  type CreateTemplate,
  type DatabaseProvider,
  type PackageManager,
} from "../types";
import { getRunScriptArgs, getRunScriptCommand } from "../utils/package-manager";

export type ComposerDeployContext = {
  template: CreateTemplate;
  packageManager: PackageManager;
  projectName: string;
  useComposerPostgres: boolean;
};

export type ComposerDeployedEntity = {
  address: string;
  kind: string;
  id: string;
  url?: string;
};

export type ComposerDeployResult = {
  appName: string;
  entities: ComposerDeployedEntity[];
};

type ComposerDeploymentSummary = {
  app: string;
  nodes: Array<{
    address: string;
    entities: Array<{ kind: string; id: string; url?: string }>;
  }>;
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

async function readComposerDeploymentSummary(
  resultFile: string,
): Promise<ComposerDeploymentSummary | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(resultFile, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.app !== "string" || !Array.isArray(record.nodes)) return undefined;

  const nodes: ComposerDeploymentSummary["nodes"] = [];
  for (const node of record.nodes) {
    if (typeof node !== "object" || node === null) return undefined;
    const nodeRecord = node as Record<string, unknown>;
    if (typeof nodeRecord.address !== "string" || !Array.isArray(nodeRecord.entities)) {
      return undefined;
    }
    const entities: ComposerDeploymentSummary["nodes"][number]["entities"] = [];
    for (const entity of nodeRecord.entities) {
      if (typeof entity !== "object" || entity === null) return undefined;
      const entityRecord = entity as Record<string, unknown>;
      if (typeof entityRecord.kind !== "string" || typeof entityRecord.id !== "string") {
        return undefined;
      }
      entities.push({
        kind: entityRecord.kind,
        id: entityRecord.id,
        ...(typeof entityRecord.url === "string" ? { url: entityRecord.url } : {}),
      });
    }
    nodes.push({ address: nodeRecord.address, entities });
  }
  return { app: record.app, nodes };
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
    "composer:deploy": "prisma-composer deploy module.ts",
    ...(context.useComposerPostgres
      ? { "composer:database:setup": "node scripts/setup-composer-postgres.mjs" }
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
  log.step("Prisma deployment output follows.");
  const deploy = getRunScriptArgs(params.context.packageManager, "deploy");
  const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), "create-prisma-deploy-"));
  const resultFile = path.join(resultDir, "result.json");
  try {
    await execa(deploy.command, deploy.args, {
      cwd: params.projectDir,
      env: {
        ...process.env,
        PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE: resultFile,
      },
      stdio: "inherit",
    });
    const summary = await readComposerDeploymentSummary(resultFile);
    log.success("Deployed to Prisma.");
    return {
      ok: true,
      result: {
        appName: summary?.app ?? (params.context.projectName || path.basename(params.projectDir)),
        entities:
          summary?.nodes.flatMap((node) =>
            node.entities.map((entity) => ({ address: node.address, ...entity })),
          ) ?? [],
      },
    };
  } catch (error) {
    const deployError = new Error(getErrorMessage(error));
    log.error(`Deploy failed: ${deployError.message}`);
    return { ok: false, cancelled: false, error: deployError };
  } finally {
    await fs.remove(resultDir);
  }
}
