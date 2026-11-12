import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CreatePromptContext } from "../src/commands/create";
import { PrismaCliCommandError } from "../src/create-outcome";
import type { TelemetryEvent } from "../src/telemetry/client";
import type { CreateCommandInput } from "../src/types";
import { CommandExecutionError, CommandRunner } from "../src/services/command-runner";
import { runPrismaJsonCommandEffect } from "../src/tasks/prisma-cli";
import { getSpawnedCommandFailure } from "../src/utils/child-process-failure";

const trackCliTelemetry = mock(async (_event: TelemetryEvent) => {});

mock.module("../src/telemetry/client", () => ({
  TELEMETRY_TIMEOUT_MS: 2_000,
  trackCliTelemetryEffect: (event: TelemetryEvent) =>
    Effect.promise(() => trackCliTelemetry(event)),
}));

const { trackCreateEffect } = await import("../src/telemetry/create");
const trackCreate = (params: Parameters<typeof trackCreateEffect>[0]) =>
  Effect.runPromise(trackCreateEffect(params));

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
    skillAgents: ["claude"],
    shouldDeploy: false,
    shouldPromptForWorkspace: false,
  },
};

beforeEach(() => trackCliTelemetry.mockClear());

describe("create telemetry", () => {
  test("reports flag names, the database target and the exit code, never values", async () => {
    const input = {
      name: "secret-app",
      template: "hono",
      provider: "postgres",
      yes: true,
    } satisfies CreateCommandInput;
    await trackCreate({ input, context: createContext, exitCode: 0 });
    await trackCreate({ input, exitCode: 1 });
    expect(trackCliTelemetry.mock.calls).toEqual([
      [
        {
          command: "create-prisma",
          flags: ["template", "provider", "yes"],
          databaseTarget: "postgres",
          exitCode: 0,
        },
      ],
      [
        {
          command: "create-prisma",
          flags: ["template", "provider", "yes"],
          databaseTarget: "postgres",
          exitCode: 1,
        },
      ],
    ]);
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
        expect(error).toBeInstanceOf(json ? PrismaCliCommandError : CommandExecutionError);
        expect(error.childProcessFailure).toBe(spec.failure);
      }
    }
  });
});
