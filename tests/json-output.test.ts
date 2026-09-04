import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { isJsonOutputRequested, writeJsonResult } from "../src/ui/json-output";

describe("isJsonOutputRequested", () => {
  test("uses the last explicit JSON flag", () => {
    expect(isJsonOutputRequested(["create-prisma", "app", "--json"])).toBe(true);
    expect(isJsonOutputRequested(["create-prisma", "app", "--json", "true"])).toBe(true);
    expect(isJsonOutputRequested(["create-prisma", "app", "--json", "false"])).toBe(false);
    expect(isJsonOutputRequested(["create-prisma", "app", "--json=false"])).toBe(false);
    expect(isJsonOutputRequested(["create-prisma", "app", "--json", "--no-json"])).toBe(false);
    expect(isJsonOutputRequested(["create-prisma", "app", "--no-json", "--json"])).toBe(true);
  });
});

describe("writeJsonResult", () => {
  test("writes one compact success result", async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((output: string) => {
      writes.push(output);
      return true;
    }) as typeof process.stdout.write;
    try {
      await Effect.runPromise(
        writeJsonResult({
          schemaVersion: 1,
          ok: true,
          project: {
            name: "my-app",
            path: "/tmp/my-app",
            template: "minimal",
            databaseProvider: "postgres",
            authoring: "psl",
            packageManager: "bun",
          },
          deployment: null,
          nextSteps: [],
          warnings: [],
        }),
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]?.split("\n")).toHaveLength(2);
    expect(writes[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(writes[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      project: {
        name: "my-app",
        path: "/tmp/my-app",
        template: "minimal",
        databaseProvider: "postgres",
        authoring: "psl",
        packageManager: "bun",
      },
      deployment: null,
      nextSteps: [],
      warnings: [],
    });
  });
});
