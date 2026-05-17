import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CreatePromptContext } from "../src/commands/create";
import type { CreateCommandInput } from "../src/types";

const trackCliTelemetry = mock(async () => {});

mock.module("../src/telemetry/client", () => ({
  trackCliTelemetry,
}));

const {
  CREATE_PRISMA_NEXT_COMPLETED_EVENT,
  CREATE_PRISMA_NEXT_FAILED_EVENT,
  trackCreateCompleted,
  trackCreateFailed,
} = await import("../src/telemetry/create");

const createInput = {
  yes: true,
  name: "app",
} satisfies CreateCommandInput;

const createContext = {
  targetDirectory: "/tmp/app",
  targetPathState: {
    exists: false,
    isDirectory: true,
    isEmptyDirectory: true,
  },
  force: false,
  template: "hono",
  projectPackageName: "app",
  prismaSetupContext: {
    projectDir: "/tmp/app",
    verbose: false,
    shouldEmit: true,
    databaseProvider: "mongo",
    authoring: "psl",
    shouldUsePrismaPostgres: false,
    packageManager: "bun",
    shouldInstall: true,
  },
} satisfies CreatePromptContext;

beforeEach(() => {
  trackCliTelemetry.mockClear();
});

describe("create telemetry", () => {
  test("tracks Prisma Next-specific completion events", async () => {
    await trackCreateCompleted({
      input: createInput,
      context: createContext,
      durationMs: 123,
    });

    expect(trackCliTelemetry).toHaveBeenCalledWith(
      CREATE_PRISMA_NEXT_COMPLETED_EVENT,
      expect.objectContaining({
        command: "create",
        template: "hono",
        "database-provider": "mongo",
        "duration-ms": 123,
      }),
    );
  });

  test("tracks Prisma Next-specific failure events", async () => {
    await trackCreateFailed({
      input: createInput,
      context: createContext,
      durationMs: 456,
      error: Object.assign(new Error("boom"), { code: "ERR_TEST" }),
      stage: "prisma_setup",
    });

    expect(trackCliTelemetry).toHaveBeenCalledWith(
      CREATE_PRISMA_NEXT_FAILED_EVENT,
      expect.objectContaining({
        command: "create",
        "duration-ms": 456,
        "error-code": "ERR_TEST",
        "failure-stage": "prisma_setup",
      }),
    );
  });
});
