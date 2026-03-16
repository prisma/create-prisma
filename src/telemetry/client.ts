import fs from "fs-extra";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PostHog } from "posthog-node";

const TELEMETRY_API_KEY = process.env.CREATE_PRISMA_TELEMETRY_API_KEY ?? "";
const TELEMETRY_HOST = process.env.CREATE_PRISMA_TELEMETRY_HOST || "https://us.i.posthog.com";
const TELEMETRY_CONFIG_FILE = "telemetry.json";
const TELEMETRY_REQUEST_TIMEOUT_MS = 800;
const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 800;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type TelemetryValue = boolean | number | string | string[] | null | undefined;
type TelemetryProperties = Record<string, TelemetryValue>;

type TelemetryConfig = {
  anonymousId: string;
};

function isTruthyEnvValue(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function shouldDisableTelemetry(): boolean {
  if (TELEMETRY_API_KEY.length === 0) {
    return true;
  }

  if (isTruthyEnvValue(process.env.CI) || isTruthyEnvValue(process.env.GITHUB_ACTIONS)) {
    return true;
  }

  return (
    process.env.CREATE_PRISMA_DISABLE_TELEMETRY !== undefined ||
    process.env.CREATE_PRISMA_TELEMETRY_DISABLED !== undefined ||
    process.env.DO_NOT_TRACK !== undefined
  );
}

function getTelemetryConfigDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "create-prisma");
  }

  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "create-prisma",
    );
  }

  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "create-prisma",
  );
}

async function getAnonymousId(): Promise<string> {
  const telemetryConfigPath = path.join(getTelemetryConfigDir(), TELEMETRY_CONFIG_FILE);

  try {
    const config = (await fs.readJSON(telemetryConfigPath)) as Partial<TelemetryConfig>;
    if (typeof config.anonymousId === "string" && UUID_V4_REGEX.test(config.anonymousId)) {
      return config.anonymousId;
    }
  } catch {
    // Ignore missing or invalid config and fall back to generating a new ID.
  }

  const anonymousId = randomUUID();

  try {
    await fs.ensureDir(path.dirname(telemetryConfigPath));
    await fs.writeJSON(
      telemetryConfigPath,
      {
        anonymousId,
      } satisfies TelemetryConfig,
      {
        spaces: 2,
      },
    );
  } catch {
    // If the config file cannot be persisted, keep using the generated ID for this run.
  }

  return anonymousId;
}

function getCommonProperties(): TelemetryProperties {
  return {
    "cli-version": process.env.CREATE_PRISMA_CLI_VERSION ?? "0.0.0",
    "node-version": process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

function sanitizeProperties(
  properties: TelemetryProperties,
): Record<string, Exclude<TelemetryValue, undefined>> {
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined),
  ) as Record<string, Exclude<TelemetryValue, undefined>>;
}

export async function trackCliTelemetry(
  event: string,
  properties: TelemetryProperties,
): Promise<void> {
  if (shouldDisableTelemetry()) {
    return;
  }

  try {
    const client = new PostHog(TELEMETRY_API_KEY, {
      host: TELEMETRY_HOST,
      captureMode: "json",
      disableGeoip: true,
      flushAt: 1,
      flushInterval: 0,
      persistence: "memory",
      requestTimeout: TELEMETRY_REQUEST_TIMEOUT_MS,
    });

    await client.captureImmediate({
      distinctId: await getAnonymousId(),
      event,
      properties: sanitizeProperties({
        ...getCommonProperties(),
        ...properties,
        $process_person_profile: false,
      }),
      disableGeoip: true,
    });

    await client.shutdown(TELEMETRY_SHUTDOWN_TIMEOUT_MS);
  } catch {
    // Telemetry should never interfere with CLI execution.
  }
}
