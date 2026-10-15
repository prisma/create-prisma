import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let bundleDir: string;
let clientPath: string;
beforeAll(async () => {
  bundleDir = await mkdtemp(path.join(import.meta.dirname, ".telemetry-client-"));
  clientPath = path.join(bundleDir, "client.mjs");
  await execa(process.execPath, [
    "build",
    fileURLToPath(new URL("../src/telemetry/client.ts", import.meta.url)),
    "--target=node",
    "--packages=external",
    "--outfile",
    clientPath,
  ]);
});
afterAll(async () => {
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

let configHome: string;
beforeEach(async () => {
  configHome = await mkdtemp(path.join(import.meta.dirname, ".telemetry-config-"));
});
afterEach(async () => {
  if (configHome) await rm(configHome, { recursive: true, force: true });
});

const installationId = "40f9096f-9b67-4de2-83ec-9d56d77f527b";
const configPath = () => path.join(configHome, "prisma", "config.json");

async function writeConfig(config: Record<string, unknown>) {
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config));
}

const event = {
  command: "create-prisma",
  flags: ["template", "yes"],
  databaseTarget: "postgres",
  exitCode: 1,
  properties: {
    outcome: "failed",
    "failure-stage": "composer_deploy",
    "error-code": "ASSEMBLE.BUILD_FAILED",
    optional: undefined,
  },
};

// A clean environment: the host's CI and coding-agent variables would otherwise decide
// whether the client sends and what it reports.
async function sendTelemetry(endpoint: string, env: Record<string, string> = {}, runs = 1) {
  const result = await execa(
    "node",
    [
      "--input-type=module",
      "--eval",
      `
        import { NodeFileSystem } from "@effect/platform-node-shared";
        import { Effect } from "effect";
        import { trackCliTelemetryEffect, TELEMETRY_TIMEOUT_MS } from ${JSON.stringify(pathToFileURL(clientPath).href)};
        for (let run = 0; run < ${runs}; run++) {
          await Effect.runPromise(trackCliTelemetryEffect(${JSON.stringify(event)}).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.timeout(TELEMETRY_TIMEOUT_MS),
            Effect.catch(() => Effect.void),
          ));
        }
      `,
    ],
    {
      cwd: import.meta.dirname,
      extendEnv: false,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: configHome,
        XDG_CONFIG_HOME: configHome,
        APPDATA: configHome,
        PRISMA_TELEMETRY_ENDPOINT: endpoint,
        CREATE_PRISMA_CLI_VERSION: "test-version",
        npm_config_user_agent: "pnpm/10.27.0 npm/? node/v24.13.0 darwin arm64",
        ...env,
      },
      timeout: 5_000,
    },
  );
  expect(result.stdout).toBe("");
  return result.stderr;
}

function startServer(onRequest: (request: Request) => Promise<Response> | Response) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: onRequest });
}

describe("telemetry POST", () => {
  test("sends the Prisma CLI's event shape with create-prisma's outcome under its installation id", async () => {
    await writeConfig({ installationId, otherSetting: true });
    const requests: Array<{ method: string; path: string; contentType: string | null; body: any }> =
      [];
    const server = startServer(async (request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        body: await request.json(),
      });
      return new Response(null, { status: 202 });
    });
    try {
      expect(await sendTelemetry(server.url.toString())).toBe("");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        method: "POST",
        path: "/events",
        contentType: "application/json",
        body: {
          installationId,
          version: "test-version",
          command: "create-prisma",
          flags: ["template", "yes"],
          runtimeName: "node",
          runtimeVersion: expect.any(String),
          os: process.platform,
          arch: process.arch,
          packageManager: "pnpm/10.27.0",
          databaseTarget: "postgres",
          tsVersion: null,
          agent: null,
          extensions: [],
          exitCode: 1,
          properties: {
            outcome: "failed",
            "failure-stage": "composer_deploy",
            "error-code": "ASSEMBLE.BUILD_FAILED",
          },
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test("discloses once on the first run and stores the id beside the existing preferences", async () => {
    await writeConfig({ otherSetting: true });
    const ids: string[] = [];
    const server = startServer(async (request) => {
      ids.push(((await request.json()) as { installationId: string }).installationId);
      return new Response(null, { status: 202 });
    });
    try {
      const stderr = await sendTelemetry(server.url.toString(), {}, 2);
      expect(stderr.match(/Prisma collects anonymous CLI usage data/g)).toHaveLength(1);
      expect(stderr).toContain("prisma telemetry disable");
      const stored = JSON.parse(await readFile(configPath(), "utf8"));
      expect(stored).toEqual({ otherSetting: true, installationId: expect.any(String) });
      expect(ids).toEqual([stored.installationId, stored.installationId]);
      expect(await sendTelemetry(server.url.toString())).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("does not send when opted out, opted out in the Prisma config, in CI, or from an unbuilt source", async () => {
    await writeConfig({ installationId });
    let requests = 0;
    const server = startServer(() => {
      requests++;
      return new Response(null, { status: 202 });
    });
    try {
      for (const env of [
        { PRISMA_DISABLE_TELEMETRY: "1" },
        { DO_NOT_TRACK: "1" },
        { CREATE_PRISMA_DISABLE_TELEMETRY: "" },
        { CREATE_PRISMA_TELEMETRY_DISABLED: "1" },
        { CI: "1" },
        { GITHUB_ACTIONS: "true" },
        { CREATE_PRISMA_CLI_VERSION: "0.0.0" },
      ]) {
        await sendTelemetry(server.url.toString(), env);
      }
      await writeConfig({ installationId, enableTelemetry: false });
      expect(await sendTelemetry(server.url.toString())).toBe("");
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("treats set-but-falsy Prisma opt-outs as not set, as the Prisma CLI does", async () => {
    await writeConfig({ installationId });
    let requests = 0;
    const server = startServer(() => {
      requests++;
      return new Response(null, { status: 202 });
    });
    try {
      await sendTelemetry(server.url.toString(), { PRISMA_DISABLE_TELEMETRY: "0" });
      await sendTelemetry(server.url.toString(), { DO_NOT_TRACK: "false" });
      expect(requests).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("aborts a stalled request and never retries or prints telemetry failures", async () => {
    await writeConfig({ installationId });
    let requests = 0;
    let aborted = false;
    const server = startServer((request) => {
      requests++;
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<Response>(() => {});
    });
    try {
      const started = performance.now();
      expect(await sendTelemetry(server.url.toString())).toBe("");
      expect(performance.now() - started).toBeLessThan(3_500);
      expect(requests).toBe(1);
      expect(aborted).toBe(true);
    } finally {
      server.stop(true);
    }
    expect(await sendTelemetry("http://127.0.0.1:1")).toBe("");
  });
});
