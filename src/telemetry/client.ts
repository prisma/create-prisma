import { Effect, FileSystem, Schema } from "effect";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PostHog } from "posthog-node";

import { applicationRuntime } from "../runtime";

const TELEMETRY_API_KEY = process.env.CREATE_PRISMA_TELEMETRY_API_KEY ?? "";
const TELEMETRY_HOST = process.env.CREATE_PRISMA_TELEMETRY_HOST || "https://us.i.posthog.com";
const TELEMETRY_CONFIG_FILE = "telemetry.json";
const AnonymousId = Schema.String.check(Schema.isUUID(4));
const decodeAnonymousId = Schema.decodeUnknownExit(AnonymousId);

type TelemetryValue = boolean | number | string | string[] | null | undefined;
type TelemetryProperties = Record<string, TelemetryValue>;

const isTruthyEnvValue = (value: string | undefined) =>
  ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );

function shouldDisableTelemetry(): boolean {
  return (
    TELEMETRY_API_KEY.length === 0 ||
    isTruthyEnvValue(process.env.CI) ||
    isTruthyEnvValue(process.env.GITHUB_ACTIONS) ||
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

const getAnonymousIdEffect = Effect.fn("Telemetry.getAnonymousId")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const configPath = path.join(getTelemetryConfigDir(), TELEMETRY_CONFIG_FILE);
  const persisted = yield* fs.readFileString(configPath).pipe(
    Effect.flatMap((source) =>
      Effect.try({
        try: () => JSON.parse(source) as { anonymousId?: unknown },
        catch: () => ({ anonymousId: undefined }),
      }),
    ),
    Effect.catch(() => Effect.succeed({ anonymousId: undefined })),
  );
  const decoded = decodeAnonymousId(persisted.anonymousId);
  if (decoded._tag === "Success") return decoded.value;

  const anonymousId = randomUUID();
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fs.writeFileString(configPath, `${JSON.stringify({ anonymousId }, null, 2)}\n`);
  }).pipe(Effect.catch(() => Effect.void));
  return anonymousId;
});

const getCommonProperties = (): TelemetryProperties => ({
  "cli-version": process.env.CREATE_PRISMA_CLI_VERSION ?? "0.0.0",
  "node-version": process.version,
  platform: process.platform,
  arch: process.arch,
});

const sanitizeProperties = (properties: TelemetryProperties) =>
  Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined),
  ) as Record<string, Exclude<TelemetryValue, undefined>>;

export const trackCliTelemetryEffect = Effect.fn("Telemetry.track")(function* (
  event: string,
  properties: TelemetryProperties,
) {
  if (shouldDisableTelemetry()) return;
  const distinctId = yield* getAnonymousIdEffect();
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new PostHog(TELEMETRY_API_KEY, {
          host: TELEMETRY_HOST,
          disableGeoip: true,
          flushAt: 1,
          flushInterval: 0,
        }),
    ),
    (posthog) =>
      Effect.tryPromise({
        try: () => posthog.shutdown(),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void)),
  );
  yield* Effect.tryPromise(() =>
    client.captureImmediate({
      distinctId,
      event,
      properties: sanitizeProperties({
        ...getCommonProperties(),
        ...properties,
        $process_person_profile: false,
      }),
      disableGeoip: true,
    }),
  );
});

export function trackCliTelemetry(event: string, properties: TelemetryProperties): Promise<void> {
  return applicationRuntime.runPromise(
    trackCliTelemetryEffect(event, properties).pipe(
      Effect.scoped,
      Effect.catch(() => Effect.void),
    ),
  );
}
