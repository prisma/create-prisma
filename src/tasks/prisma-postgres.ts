import { execa } from "execa";

import type { PackageManager, PrismaPostgresResult } from "../types";
import {
  getPackageExecutionArgs,
  getPackageExecutionCommand,
} from "../utils/package-manager";

type CreateDbJsonPayload = {
  success?: boolean;
  error?: string;
  message?: string;
  connectionString?: string;
  databaseUrl?: string;
  claimUrl?: string;
  claimURL?: string;
};

export const PRISMA_POSTGRES_TEMPORARY_NOTICE =
  "Prisma Postgres is temporary for 24 hours. Claim this database before it expires using CLAIM_URL.";
const CREATE_DB_COMMAND_ARGS = ["create-db@latest", "--json"] as const;

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

export async function provisionPrismaPostgres(
  packageManager: PackageManager,
  projectDir = process.cwd()
): Promise<PrismaPostgresResult> {
  const command = getPackageExecutionArgs(packageManager, [
    ...CREATE_DB_COMMAND_ARGS,
  ]);
  const commandString = getCreateDbCommand(packageManager);

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
      throw new Error(`Failed to run ${commandString}: ${message}`);
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

  return {
    databaseUrl,
    claimUrl,
  };
}

export function getCreateDbCommand(packageManager: PackageManager): string {
  return getPackageExecutionCommand(packageManager, [...CREATE_DB_COMMAND_ARGS]);
}
