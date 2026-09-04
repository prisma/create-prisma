import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { shutdownTelemetryClientEffect } from "../src/telemetry/client";

describe("telemetry client shutdown", () => {
  test("bounds cleanup even when the client does not settle", async () => {
    let receivedTimeout: number | undefined;
    const startedAt = performance.now();

    await Effect.runPromise(
      Effect.acquireRelease(
        Effect.succeed({
          shutdown: (timeoutMs) => {
            receivedTimeout = timeoutMs;
            return new Promise<void>(() => {});
          },
        }),
        (client) => shutdownTelemetryClientEffect(client, 20),
      ).pipe(Effect.scoped),
    );

    expect(receivedTimeout).toBe(20);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
