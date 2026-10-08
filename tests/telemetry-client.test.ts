import { describe, expect, test } from "bun:test";
import { execa } from "execa";
import { fileURLToPath } from "node:url";

const clientPath = fileURLToPath(new URL("../src/telemetry/client.ts", import.meta.url));
const anonymousId = "40f9096f-9b67-4de2-83ec-9d56d77f527b";
const optOuts = [
  "DO_NOT_TRACK",
  "CREATE_PRISMA_DISABLE_TELEMETRY",
  "CREATE_PRISMA_TELEMETRY_DISABLED",
  "CI",
  "GITHUB_ACTIONS",
];

async function sendTelemetry(
  host: string,
  env: Record<string, string> = {},
  events = ["cli:create_prisma_next_command_completed"],
) {
  const result = await execa(
    process.execPath,
    [
      "--eval",
      `
        import { Effect, FileSystem } from "effect";
        import { trackCliTelemetryEffect, TELEMETRY_TIMEOUT_MS } from ${JSON.stringify(clientPath)};
        const fs = FileSystem.makeNoop({
          readFileString: () => Effect.succeed(${JSON.stringify(JSON.stringify({ anonymousId }))}),
        });
        for (const event of ${JSON.stringify(events)}) {
          await Effect.runPromise(trackCliTelemetryEffect(event, {
            "failure-stage": "composer_deploy",
            "error-code": "ASSEMBLE.BUILD_FAILED",
            optional: undefined,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.timeout(TELEMETRY_TIMEOUT_MS),
            Effect.catch(() => Effect.void),
          ));
        }
      `,
    ],
    {
      env: {
        ...Object.fromEntries(optOuts.map((key) => [key, undefined])),
        CREATE_PRISMA_TELEMETRY_API_KEY: "test-project-token",
        CREATE_PRISMA_TELEMETRY_HOST: host,
        CREATE_PRISMA_CLI_VERSION: "test-version",
        ...env,
      },
      timeout: 5_000,
    },
  );
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
}

describe("telemetry POST", () => {
  test("sends one anonymous request per outcome with the existing properties and identity", async () => {
    const requests: Array<{
      method: string;
      path: string;
      contentType: string | null;
      body: { properties: Record<string, unknown>; timestamp: string };
    }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          contentType: request.headers.get("content-type"),
          body: await request.json(),
        });
        return new Response(null, { status: 204 });
      },
    });
    const events = [
      "cli:create_prisma_next_command_completed",
      "cli:create_prisma_next_command_failed",
      "cli:create_prisma_next_command_cancelled",
    ];
    try {
      await sendTelemetry(server.url.toString(), {}, events);
      expect(requests).toHaveLength(events.length);
      for (const [index, request] of requests.entries()) {
        expect(request).toMatchObject({
          method: "POST",
          path: "/i/v0/e/",
          contentType: "application/json",
          body: {
            api_key: "test-project-token",
            distinct_id: anonymousId,
            event: events[index],
            properties: {
              "cli-version": "test-version",
              platform: process.platform,
              arch: process.arch,
              "failure-stage": "composer_deploy",
              "error-code": "ASSEMBLE.BUILD_FAILED",
              $process_person_profile: false,
              $geoip_disable: true,
            },
          },
        });
        expect(request.body.properties).not.toHaveProperty("optional");
        expect(Number.isNaN(Date.parse(request.body.timestamp))).toBe(false);
      }
    } finally {
      server.stop(true);
    }
  });

  test("does not send when opted out, in CI, or without a project token", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response(null, { status: 204 });
      },
    });
    try {
      for (const key of optOuts) await sendTelemetry(server.url.toString(), { [key]: "1" });
      await sendTelemetry(server.url.toString(), { CREATE_PRISMA_TELEMETRY_API_KEY: "" });
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("aborts a stalled request and never retries or prints telemetry failures", async () => {
    let requests = 0;
    let aborted = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests++;
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<Response>(() => {});
      },
    });
    try {
      const started = performance.now();
      await sendTelemetry(server.url.toString());
      expect(performance.now() - started).toBeLessThan(3_500);
      expect(requests).toBe(1);
      expect(aborted).toBe(true);
    } finally {
      server.stop(true);
    }
    await sendTelemetry("http://127.0.0.1:1");
  });
});
