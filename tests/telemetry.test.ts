import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CreatePromptContext } from "../src/commands/create";
import type { CreateCommandInput } from "../src/types";

const trackCliTelemetry = mock(async () => {});

mock.module("../src/telemetry/client", () => ({ trackCliTelemetry }));

const {
  CREATE_PRISMA_NEXT_CANCELLED_EVENT,
  CREATE_PRISMA_NEXT_COMPLETED_EVENT,
  CREATE_PRISMA_NEXT_FAILED_EVENT,
  trackCreateCancelled,
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
        "telemetry-schema-version": 2,
        template: "hono",
        "database-provider": "postgres",
        "should-deploy": true,
        "duration-ms": 123,
      }),
    );
  });

  test("tracks a normalized setup failure without its raw message", async () => {
    await trackCreateFailed({
      input: createInput,
      context: createContext,
      durationMs: 456,
      error: Object.assign(new Error("DATABASE_URL=secret"), { code: "ERR_TEST" }),
      stage: "plan_migration",
      reason: "migration_plan_failed",
    });
    const [event, properties] = trackCliTelemetry.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe(CREATE_PRISMA_NEXT_FAILED_EVENT);
    expect(properties).toEqual(
      expect.objectContaining({
        "duration-ms": 456,
        "failure-class": "technical_failure",
        "error-code": "ERR_TEST",
        "failure-stage": "plan_migration",
        "failure-reason": "migration_plan_failed",
      }),
    );
    expect(properties).not.toHaveProperty("error-message");
    expect(JSON.stringify(properties)).not.toContain("secret");
  });

  test("separates expected input and environment rejections from technical failures", async () => {
    for (const reason of ["target_directory_not_empty", "workspace_missing"] as const) {
      await trackCreateFailed({
        input: createInput,
        context: createContext,
        durationMs: 10,
        stage: reason === "workspace_missing" ? "select_workspace" : "collect_context",
        reason,
      });
    }
    const calls = trackCliTelemetry.mock.calls as Array<[string, Record<string, unknown>]>;
    expect(calls).toHaveLength(2);
    expect(calls.map(([, properties]) => properties["failure-reason"])).toEqual([
      "target_directory_not_empty",
      "workspace_missing",
    ]);
    for (const [, properties] of calls) {
      expect(properties["failure-class"]).toBe("expected_rejection");
    }
  });

  test("tracks stable Prisma CLI failure fields without raw output", async () => {
    await trackCreateFailed({
      input: createInput,
      context: createContext,
      durationMs: 456,
      error: Object.assign(new Error("token=secret"), {
        prismaCliCommand: "app.deploy",
        prismaCliErrorCode: "APP.DEPLOY_FAILED",
      }),
      stage: "composer_deploy",
      reason: "composer_deploy_failed",
    });
    const [, properties] = trackCliTelemetry.mock.calls[0] as [string, Record<string, unknown>];
    expect(properties).toEqual(
      expect.objectContaining({
        "prisma-cli-command": "app.deploy",
        "prisma-cli-error-code": "APP.DEPLOY_FAILED",
      }),
    );
    expect(JSON.stringify(properties)).not.toContain("secret");
  });

  test("classifies child-process failures without capturing command output", async () => {
    const cases = [
      [{ timedOut: true }, "timed_out"],
      [{ isCanceled: true }, "cancelled"],
      [{ isMaxBuffer: true }, "max_buffer"],
      [{ signal: "SIGINT", isTerminated: true }, "interrupted"],
      [{ exitCode: 0xc000013a }, "interrupted"],
      [{ signal: "SIGTERM", isTerminated: true }, "terminated"],
      [{ code: "ENOENT" }, "command_not_found"],
      [{ code: "EACCES" }, "permission_denied"],
      [{ exitCode: 1 }, "non_zero_exit"],
      [{ code: "UNKNOWN" }, "spawn_failed"],
    ] as const;

    for (const [details, expectedFailure] of cases) {
      await trackCreateFailed({
        input: createInput,
        context: createContext,
        durationMs: 10,
        error: Object.assign(new Error("token=secret"), {
          name: "ExecaError",
          failed: true,
          ...details,
        }),
        stage: "install_dependencies",
        reason: "dependency_install_failed",
      });

      const [, properties] = trackCliTelemetry.mock.calls.at(-1) as [
        string,
        Record<string, unknown>,
      ];
      expect(properties["child-process-failure"]).toBe(expectedFailure);
      expect(JSON.stringify(properties)).not.toContain("secret");
    }
  });

  test("tracks prompt cancellation as a separate outcome", async () => {
    await trackCreateCancelled({
      input: createInput,
      context: createContext,
      durationMs: 789,
      stage: "select_workspace",
    });
    expect(trackCliTelemetry).toHaveBeenCalledWith(
      CREATE_PRISMA_NEXT_CANCELLED_EVENT,
      expect.objectContaining({
        "duration-ms": 789,
        "cancellation-stage": "select_workspace",
        "should-deploy": true,
      }),
    );
  });
});
