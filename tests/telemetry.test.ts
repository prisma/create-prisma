import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CreatePromptContext } from "../src/commands/create";
import type { CreateCommandInput } from "../src/types";

const trackCliTelemetry = mock(async () => {});

mock.module("../src/telemetry/client", () => ({ trackCliTelemetry }));

const {
  CREATE_PRISMA_NEXT_COMPLETED_EVENT,
  CREATE_PRISMA_NEXT_FAILED_EVENT,
  trackCreateCompleted,
  trackCreateFailed,
} = await import("../src/telemetry/create");

const createInput = { yes: true, name: "app" } satisfies CreateCommandInput;
const createContext: CreatePromptContext = {
  targetDirectory: "/tmp/app",
  targetPathState: { exists: false, isDirectory: true, isEmptyDirectory: true },
  force: false,
  template: "hono",
  projectPackageName: "app",
  prismaSetupContext: {
    projectDir: "/tmp/app",
    verbose: false,
    databaseProvider: "postgres",
    authoring: "psl",
    packageManager: "bun",
    shouldDeploy: true,
    shouldPromptForWorkspace: false,
  },
};

beforeEach(() => trackCliTelemetry.mockClear());

describe("create telemetry", () => {
  test("tracks Composer deployment intent on completion", async () => {
    await trackCreateCompleted({ input: createInput, context: createContext, durationMs: 123 });
    expect(trackCliTelemetry).toHaveBeenCalledWith(
      CREATE_PRISMA_NEXT_COMPLETED_EVENT,
      expect.objectContaining({
        command: "create",
        template: "hono",
        "database-provider": "postgres",
        "should-deploy": true,
        "duration-ms": 123,
      }),
    );
  });

  test("tracks setup failures", async () => {
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
        "duration-ms": 456,
        "error-code": "ERR_TEST",
        "failure-stage": "prisma_setup",
      }),
    );
  });
});
