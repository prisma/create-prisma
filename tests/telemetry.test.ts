import { beforeEach, describe, expect, mock, test } from "bun:test";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { Effect } from "effect";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CreatePromptContext } from "../src/commands/create";
import type { CreateCommandInput } from "../src/types";
import { CommandExecutionError, CommandRunner } from "../src/services/command-runner";
import { runComposerDeployEffect } from "../src/tasks/composer/deploy-report";
import { runPrismaJsonCommandEffect } from "../src/tasks/prisma-cli";
import { getChildProcessFailure } from "../src/utils/child-process-failure";

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

async function failComposerDeploy(report?: string) {
  let reportPath = "";
  const run = (spec: { args: readonly string[] }) =>
    Effect.sync(() => {
      reportPath = spec.args[spec.args.indexOf("--report") + 1]!;
      if (report !== undefined) writeFileSync(reportPath, report);
      return {
        exitCode: 1,
        stdout: '{"ok":false,"commandId":"deploy","error":{"code":"CLI.CHILD_PROCESS_FAILED"}}',
        stderr: "",
      };
    });
  const error = await Effect.runPromise(
    runComposerDeployEffect({ packageManager: "npm", projectDir: process.cwd() }).pipe(
      Effect.provideService(CommandRunner, { run, runChecked: run }),
      Effect.provide(NodeFileSystem.layer),
      Effect.flip,
    ),
  );
  return { error, reportPath };
}

async function trackFailure(error: unknown, stage: "install_dependencies" | "composer_deploy") {
  await trackCreateFailed({
    input: createInput,
    context: createContext,
    durationMs: 10,
    error,
    stage,
    reason: stage === "composer_deploy" ? "composer_deploy_failed" : "dependency_install_failed",
  });
  return (trackCliTelemetry.mock.calls.at(-1) as unknown as [string, Record<string, unknown>])[1];
}

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
    expect(calls).toHaveLength(4);
    expect(calls.map(([, properties]) => properties["failure-reason"])).toEqual([
      "target_directory_not_empty",
      "target_has_migrations",
      "workspace_missing",
      "unsupported_package_manager_version",
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

  test("tracks the package manager's error code for install failures", async () => {
    const properties = await trackFailure(
      new CommandExecutionError({
        command: "npm",
        args: ["install"],
        exitCode: 1,
        stdout: "",
        stderr:
          "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope",
      }),
      "install_dependencies",
    );
    expect(properties["package-manager-error-code"]).toBe("E404");
    expect(JSON.stringify(properties)).not.toContain("registry");
  });

  test("tracks Composer's failure code from the deploy report", async () => {
    const { error, reportPath } = await failComposerDeploy(
      JSON.stringify({
        version: 1,
        failure: { code: "DEPLOY.ENGINE_FAILED", message: "failed in /Users/jane/my-app" },
      }),
    );
    const properties = await trackFailure(error, "composer_deploy");
    expect(properties["prisma-cli-error-code"]).toBe("CLI.CHILD_PROCESS_FAILED");
    expect(properties["prisma-cli-cause-code"]).toBe("DEPLOY.ENGINE_FAILED");
    expect(JSON.stringify(properties)).not.toContain("jane");
    expect(existsSync(path.dirname(reportPath))).toBe(false);
  });

  test("keeps the original deploy error when the report is missing or invalid", async () => {
    for (const report of [undefined, "not json"]) {
      const { error } = await failComposerDeploy(report);
      expect(error).toMatchObject({ code: "CLI.CHILD_PROCESS_FAILED", exitCode: 1 });
      expect(error).not.toHaveProperty("causeCode");
      expect((await trackFailure(error, "composer_deploy"))["prisma-cli-cause-code"]).toBeNull();
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
