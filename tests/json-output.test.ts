import { describe, expect, test } from "bun:test";

import { createJsonOutputLogger, isJsonOutputRequested } from "../src/ui/json-output";

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

describe("createJsonOutputLogger", () => {
  test("writes one compact success result", () => {
    const outputs: string[] = [];
    const logger = createJsonOutputLogger((output) => outputs.push(output));

    logger.info?.({
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

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.split("\n")).toHaveLength(2);
    expect(outputs[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(outputs[0]!)).toEqual({
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

  test("turns parser errors into one structured failure", () => {
    const outputs: string[] = [];
    const logger = createJsonOutputLogger((output) => outputs.push(output));

    logger.error?.("Invalid template");
    logger.info?.({ unexpected: true });

    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { stage: "parse_arguments", message: "Invalid template" },
    });
  });

  test("turns unexpected info values into a structured failure", () => {
    const outputs: string[] = [];
    const logger = createJsonOutputLogger((output) => outputs.push(output));

    logger.info?.({ unexpected: true });

    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        stage: "parse_arguments",
        message: '{"unexpected":true}',
      },
    });
  });
});
