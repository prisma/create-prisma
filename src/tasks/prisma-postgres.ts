import { execa } from "execa";

import type { PackageManager } from "../types";

type CreateDbJsonPayload = {
  success?: boolean;
  error?: string;
  message?: string;
  connectionString?: string;
  databaseUrl?: string;
  claimUrl?: string;
  claimURL?: string;
  deletionDate?: string;
  deletionAt?: string;
  region?: string;
  name?: string;
  projectId?: string;
  projectID?: string;
};

export type PrismaPostgresResult = {
  databaseUrl: string;
  claimUrl?: string;
  deletionDate?: string;
  region?: string;
  name?: string;
  projectId?: string;
};

function getCreateDbCommandArgs(
  packageManager: PackageManager
): { command: string; args: string[] } {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", "create-db@latest", "--json"] };
    case "bun":
      return { command: "bunx", args: ["create-db@latest", "--json"] };
    case "npm":
    default:
      return { command: "npx", args: ["create-db@latest", "--json"] };
  }
}

function parseCreateDbJson(rawOutput: string): CreateDbJsonPayload {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    throw new Error("create-db returned empty output.");
  }

  const jsonCandidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonCandidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of jsonCandidates) {
    try {
      return JSON.parse(candidate) as CreateDbJsonPayload;
    } catch {
      // Continue trying candidates.
    }
  }

  throw new Error(`Unable to parse create-db JSON output: ${trimmed}`);
}

function pickConnectionString(payload: CreateDbJsonPayload): string | undefined {
  if (typeof payload.connectionString === "string" && payload.connectionString.length > 0) {
    return payload.connectionString;
  }

  if (typeof payload.databaseUrl === "string" && payload.databaseUrl.length > 0) {
    return payload.databaseUrl;
  }

  return undefined;
}

function extractErrorMessage(
  payload: CreateDbJsonPayload,
  fallback: string
): string {
  if (typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }

  if (typeof payload.error === "string" && payload.error.length > 0) {
    return payload.error;
  }

  return fallback;
}

export function getCreateDbCommandString(packageManager: PackageManager): string {
  const command = getCreateDbCommandArgs(packageManager);
  return [command.command, ...command.args].join(" ");
}

export async function provisionPrismaPostgres(
  packageManager: PackageManager,
  projectDir = process.cwd()
): Promise<PrismaPostgresResult> {
  const command = getCreateDbCommandArgs(packageManager);

  let stdout: string;
  try {
    const result = await execa(command.command, command.args, {
      cwd: projectDir,
      stdio: "pipe",
    });
    stdout = result.stdout;
  } catch (error) {
    if (error instanceof Error && "stderr" in error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
      const message = stderr.length > 0 ? stderr : error.message;
      throw new Error(`Failed to run ${getCreateDbCommandString(packageManager)}: ${message}`);
    }

    throw error;
  }

  const payload = parseCreateDbJson(stdout);
  if (payload.success === false) {
    throw new Error(extractErrorMessage(payload, "create-db reported failure."));
  }

  const databaseUrl = pickConnectionString(payload);
  if (!databaseUrl) {
    throw new Error("create-db did not return a connection string.");
  }

  const claimUrl =
    typeof payload.claimUrl === "string" && payload.claimUrl.length > 0
      ? payload.claimUrl
      : typeof payload.claimURL === "string" && payload.claimURL.length > 0
        ? payload.claimURL
        : undefined;

  const deletionDate =
    typeof payload.deletionDate === "string" && payload.deletionDate.length > 0
      ? payload.deletionDate
      : typeof payload.deletionAt === "string" && payload.deletionAt.length > 0
        ? payload.deletionAt
        : undefined;

  const projectId =
    typeof payload.projectId === "string" && payload.projectId.length > 0
      ? payload.projectId
      : typeof payload.projectID === "string" && payload.projectID.length > 0
        ? payload.projectID
        : undefined;

  const name =
    typeof payload.name === "string" && payload.name.length > 0
      ? payload.name
      : undefined;

  return {
    databaseUrl,
    claimUrl,
    deletionDate,
    region: payload.region,
    name,
    projectId,
  };
}
