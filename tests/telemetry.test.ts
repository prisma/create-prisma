import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CreatePromptContext } from "../src/commands/create";
import type { CreateCommandInput } from "../src/types";
import { CommandExecutionError, CommandRunner } from "../src/services/command-runner";
import { runPrismaJsonCommandEffect } from "../src/tasks/prisma-cli";
import {
  getChildProcessFailure,
  getSpawnedCommandFailure,
} from "../src/utils/child-process-failure";

const trackCliTelemetry = mock(async () => {});

mock.module("../src/telemetry/client", () => ({
  TELEMETRY_TIMEOUT_MS: 2_000,
  trackCliTelemetryEffect: (event: string, properties: Record<string, unknown>) =>
    Effect.promise(() => trackCliTelemetry(event, properties)),
}));

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
    skillAgents: ["claude", "cursor", "agents", "devin"],
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
    for (const reason of [
      "target_directory_not_empty",
      "target_has_migrations",
      "workspace_missing",
      "unsupported_package_manager_version",
      "package_manager_not_found",
    ] as const) {
      await trackCreateFailed({
        input: createInput,
        context: createContext,
        durationMs: 10,
        stage: reason === "workspace_missing" ? "select_workspace" : "collect_context",
        reason,
      });
    }
    const calls = trackCliTelemetry.mock.calls as Array<[string, Record<string, unknown>]>;
    expect(calls).toHaveLength(5);
    expect(calls.map(([, properties]) => properties["failure-reason"])).toEqual([
      "target_directory_not_empty",
      "target_has_migrations",
      "workspace_missing",
      "unsupported_package_manager_version",
      "package_manager_not_found",
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
        error: new CommandExecutionError({
          command: "secret-command",
          args: ["secret-argument"],
          stdout: "token=secret",
          stderr: "token=secret",
          childProcessFailure: getChildProcessFailure({
            name: "ExecaError",
            failed: true,
            ...details,
          }),
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

  test("recognizes a missing Windows command that cmd.exe reports as a failed exit", async () => {
    const binDirectory = await mkdtemp(path.join(tmpdir(), "create-prisma-bin-"));
    try {
      await writeFile(path.join(binDirectory, "pnpm.CMD"), "");
      const classify = (command: string) =>
        getSpawnedCommandFailure(
          { name: "ExecaError", failed: true, exitCode: 1 },
          { command, cwd: tmpdir(), env: { Path: binDirectory }, platform: "win32" },
        );
      expect(classify("yarn")).toBe("command_not_found");
      expect(classify("pnpm")).toBe("non_zero_exit");
    } finally {
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("preserves real process failures through checked and Prisma JSON commands", async () => {
    const cases = [
      { command: "create-prisma-nonexistent-test-command", args: [], failure: "command_not_found" },
      { command: process.execPath, args: ["-e", "process.exit(130)"], failure: "interrupted" },
      {
        command: process.execPath,
        args: ["-e", "console.error('token=secret'); process.exit(2)"],
        failure: "non_zero_exit",
      },
      {
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({ok: false, error: {code: "AUTH.LOGIN_DENIED", summary: "Sign-in was not authorized."}})); process.exit(1)`,
        ],
        failure: "non_zero_exit",
      },
    ];

    for (const spec of cases) {
      for (const json of [false, true]) {
        const error = await Effect.runPromise(
          Effect.gen(function* () {
            const runner = yield* CommandRunner;
            const command = { command: spec.command, args: spec.args, cwd: process.cwd() };
            return yield* json
              ? runPrismaJsonCommandEffect({
                  packageManager: "npm",
                  projectDir: process.cwd(),
                  args: ["init"],
                }).pipe(
                  Effect.provideService(CommandRunner, {
                    ...runner,
                    run: () => runner.run(command),
                  }),
                )
              : runner.runChecked(command);
          }).pipe(Effect.provide(CommandRunner.layer), Effect.flip),
        );
        await trackCreateFailed({
          input: createInput,
          durationMs: 10,
          error,
          stage: json ? "initialize_prisma" : "install_dependencies",
          reason: json ? "prisma_init_failed" : "dependency_install_failed",
        });
        const [, properties] = trackCliTelemetry.mock.calls.at(-1) as [
          string,
          Record<string, unknown>,
        ];
        expect(properties["child-process-failure"]).toBe(spec.failure);
        expect(properties["error-name"]).toBe(
          json ? "PrismaCliCommandError" : "CommandExecutionError",
        );
        expect(JSON.stringify(properties)).not.toContain("secret");
      }
    }
  });

  test.each(["select_workspace", "authenticate"] as const)(
    "tracks %s cancellation as a separate outcome",
    async (stage) => {
      await trackCreateCancelled({
        input: createInput,
        context: createContext,
        durationMs: 789,
        stage,
      });
      expect(trackCliTelemetry).toHaveBeenCalledWith(
        CREATE_PRISMA_NEXT_CANCELLED_EVENT,
        expect.objectContaining({
          "duration-ms": 789,
          "cancellation-stage": stage,
          "should-deploy": true,
        }),
      );
    },
  );
});
