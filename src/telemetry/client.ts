import { determineAgent } from "@vercel/detect-agent";
import ci from "ci-info";
import { Effect, FileSystem } from "effect";
import { randomUUID } from "node:crypto";
import path from "node:path";

// The Prisma CLI's anonymous usage backend (`prisma/orm` apps/telemetry-backend).
// create-prisma rows share its table and are told apart by their `command`.
const TELEMETRY_BACKEND_URL = "https://cmpbfbsdp09hr3jf7pojjs5qs.ewr.prisma.build";
const TELEMETRY_DOCS_URL = "https://www.prisma.io/docs/cli";
export const TELEMETRY_TIMEOUT_MS = 2_000;

type TelemetryValue = boolean | number | string | string[] | null | undefined;
export type TelemetryProperties = Record<string, TelemetryValue>;

export type TelemetryEvent = {
  command: string;
  flags: string[];
  databaseTarget: string | null;
  exitCode: number;
  properties: TelemetryProperties;
};

type PrismaUserConfig = Record<string, unknown> & {
  enableTelemetry?: unknown;
  installationId?: unknown;
};

const getCliVersion = () => process.env.CREATE_PRISMA_CLI_VERSION ?? "0.0.0";

// The Prisma CLI's spelling: set-but-falsy values ('', '0', 'false') do not opt out.
const isTruthyOptOut = (value: string | undefined) =>
  value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase());

function isTelemetryDisabledByEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    // Unbuilt source runs (tests, `bun run dev`) carry no release to attribute.
    getCliVersion() === "0.0.0" ||
    ci.isCI ||
    isTruthyOptOut(env.PRISMA_DISABLE_TELEMETRY) ||
    isTruthyOptOut(env.DO_NOT_TRACK) ||
    // create-prisma's own opt-outs from before it shared the Prisma CLI's consent.
    env.CREATE_PRISMA_DISABLE_TELEMETRY !== undefined ||
    env.CREATE_PRISMA_TELEMETRY_DISABLED !== undefined
  );
}

// The Prisma CLI's preference store, so `prisma telemetry disable` covers create-prisma
// and both report under one installation id.
function getPrismaUserConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const set = (value: string | undefined) => (value ? value : undefined);
  if (process.platform === "win32") {
    const appData = set(env.APPDATA);
    if (appData) return path.join(appData, "prisma", "config.json");
    const userProfile = set(env.USERPROFILE);
    return userProfile
      ? path.join(userProfile, "AppData", "Roaming", "prisma", "config.json")
      : undefined;
  }
  const xdg = set(env.XDG_CONFIG_HOME);
  if (xdg) return path.join(xdg, "prisma", "config.json");
  const home = set(env.HOME);
  return home ? path.join(home, ".config", "prisma", "config.json") : undefined;
}

const firstRunNotice = [
  "Prisma collects anonymous CLI usage data, enabled by default.",
  `What's collected and why: ${TELEMETRY_DOCS_URL}.`,
  'Opt out: run "prisma telemetry disable", set DO_NOT_TRACK=1 or',
  "PRISMA_DISABLE_TELEMETRY=1.",
].join(" ");

const readPrismaUserConfigEffect = Effect.fn("Telemetry.readUserConfig")(function* (
  configPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(configPath).pipe(
    Effect.flatMap((source) =>
      Effect.try({
        try: () => JSON.parse(source) as unknown,
        catch: () => undefined,
      }),
    ),
    Effect.map((parsed): PrismaUserConfig =>
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as PrismaUserConfig)
        : {},
    ),
    Effect.catch(() => Effect.succeed<PrismaUserConfig>({})),
  );
});

// Discloses once, then stores the id beside the existing preferences (temp file + rename,
// as the Prisma CLI writes it). A failed write sends nothing and discloses again next run.
const discloseAndMintEffect = Effect.fn("Telemetry.discloseAndMint")(function* (
  configPath: string,
  config: PrismaUserConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.sync(() => process.stderr.write(`${firstRunNotice}\n`));
  const installationId = randomUUID();
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  return yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fs.writeFileString(
      tmpPath,
      `${JSON.stringify({ ...config, installationId }, null, 2)}\n`,
    );
    yield* fs.rename(tmpPath, configPath);
    return installationId;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

const resolveInstallationIdEffect = Effect.fn("Telemetry.resolveInstallationId")(function* () {
  const configPath = getPrismaUserConfigPath();
  if (!configPath) return undefined;
  const config = yield* readPrismaUserConfigEffect(configPath);
  if (config.enableTelemetry === false) return undefined;
  if (typeof config.installationId === "string" && config.installationId.length > 0) {
    return config.installationId;
  }
  return yield* discloseAndMintEffect(configPath, config);
});

function getRuntime(): { name: string; version: string } {
  if (process.versions.bun !== undefined) return { name: "bun", version: process.versions.bun };
  if (process.versions.deno !== undefined) return { name: "deno", version: process.versions.deno };
  return { name: "node", version: process.versions.node };
}

// `pnpm/10.27.0 npm/? node/v24.13.0 darwin arm64` → `pnpm/10.27.0`
function getInvokingPackageManager(userAgent = process.env.npm_config_user_agent): string | null {
  const first = userAgent?.split(/\s+/)[0];
  return first?.includes("/") ? first : null;
}

// Integration tests point the client at a local server, as they do for the Prisma CLI.
function getTelemetryEndpoint(override = process.env.PRISMA_TELEMETRY_ENDPOINT): string {
  try {
    return new URL("/events", override || TELEMETRY_BACKEND_URL).toString();
  } catch {
    return new URL("/events", TELEMETRY_BACKEND_URL).toString();
  }
}

const sanitizeProperties = (properties: TelemetryProperties) =>
  Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined),
  ) as Record<string, Exclude<TelemetryValue, undefined>>;

export const trackCliTelemetryEffect = Effect.fn("Telemetry.track")(function* (
  event: TelemetryEvent,
) {
  if (isTelemetryDisabledByEnvironment()) return;
  const installationId = yield* resolveInstallationIdEffect();
  if (!installationId) return;
  const agent = yield* Effect.promise(() =>
    determineAgent().then(
      (result) => (result.isAgent ? result.agent.name : null),
      () => null,
    ),
  );
  const runtime = getRuntime();
  yield* Effect.tryPromise(async (signal) => {
    const response = await fetch(getTelemetryEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({
        installationId,
        version: getCliVersion(),
        command: event.command,
        flags: event.flags,
        runtimeName: runtime.name,
        runtimeVersion: runtime.version,
        os: process.platform,
        arch: process.arch,
        packageManager: getInvokingPackageManager(),
        databaseTarget: event.databaseTarget,
        tsVersion: null,
        agent,
        extensions: [],
        exitCode: event.exitCode,
        properties: sanitizeProperties(event.properties),
      }),
      signal,
    });
    await response.body?.cancel();
  });
});
