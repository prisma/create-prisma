import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { PassThrough } from "node:stream";

import { CreateCancellationError, CreateFailure } from "../src/create-outcome";
import { applicationRuntime } from "../src/runtime";
import { CommandExecutionError, CommandRunner } from "../src/services/command-runner";
import {
  deployNewProjectWithComposer,
  deployNewProjectWithComposerEffect,
  findProjectNameCollisions,
  getConsoleProjectUrl,
  parseComposerDeployResult,
  parsePrismaCliEnvelope,
  PrismaCliCommandError,
} from "../src/tasks/deploy-with-composer";
import { getErrorMessage, redactSecrets } from "../src/utils/errors";

describe("redactSecrets", () => {
  test("redacts supported database URLs", () => {
    expect(
      redactSecrets(
        "postgresql://user:pass@host/db mongodb://user:pass@host/db mongodb+srv://user:pass@host/db",
      ),
    ).toBe("postgresql://<redacted> mongodb://<redacted> mongodb+srv://<redacted>");
  });

  test("redacts mixed-case assignments and quoted values", () => {
    expect(
      redactSecrets(
        "database_url = \"postgresql://user:pass@host/db\" MongoDb_Uri='mongodb://secret' Api_Token=token-value",
      ),
    ).toBe("database_url = <redacted> MongoDb_Uri=<redacted> Api_Token=<redacted>");
  });

  test("redacts bearer credentials without hiding public app URLs", () => {
    expect(
      redactSecrets(
        "Authorization: Bearer header.payload.signature App: https://example.prisma.build",
      ),
    ).toBe("Authorization: Bearer <redacted> App: https://example.prisma.build");
  });

  test("redacts captured subprocess stderr", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "DATABASE_URL=postgresql://user:password@host/database",
    });

    expect(getErrorMessage(error)).toBe("DATABASE_URL=<redacted>");
  });

  test("prefers a structured Prisma error over package-manager stderr", () => {
    const error = new PrismaCliCommandError({
      message: "Explicit overwrite consent is required",
      code: "CLI.CONSENT_REQUIRED",
      stderr: 'error: "prisma" exited with code 2',
      exitCode: 2,
    });
    expect(getErrorMessage(error)).toBe("Explicit overwrite consent is required");
  });
});

describe("findProjectNameCollisions", () => {
  test("returns every exact project-name match", () => {
    expect(
      findProjectNameCollisions(
        [
          { id: "proj_first", name: "my-app" },
          { id: "proj_other", name: "my-app-api" },
          { id: "proj_second", name: "my-app" },
        ],
        "my-app",
      ),
    ).toEqual([
      { id: "proj_first", name: "my-app" },
      { id: "proj_second", name: "my-app" },
    ]);
  });

  test("does not treat a differently-cased name as the same project", () => {
    expect(findProjectNameCollisions([{ id: "proj_upper", name: "My-App" }], "my-app")).toEqual([]);
  });
});

describe("getConsoleProjectUrl", () => {
  test("converts Management API resource ids to Console route ids", () => {
    expect(getConsoleProjectUrl("wksp_workspace123", "proj_project123")).toBe(
      "https://console.prisma.io/workspace123/project123",
    );
  });

  test("preserves raw workspace and project ids", () => {
    expect(getConsoleProjectUrl("workspace123", "project123")).toBe(
      "https://console.prisma.io/workspace123/project123",
    );
  });
});

describe("parsePrismaCliEnvelope", () => {
  test("reads the terminal result after progress frames", () => {
    expect(
      parsePrismaCliEnvelope(
        [
          '{"kind":"progress","message":"Deploying"}',
          '{"kind":"result","envelope":{"ok":true,"result":{"summary":null}}}',
        ].join("\n"),
      ),
    ).toEqual({ ok: true, result: { summary: null } });
  });

  test("preserves stable command and error codes from a failure envelope", () => {
    const envelope = parsePrismaCliEnvelope(
      JSON.stringify({
        kind: "result",
        envelope: {
          ok: false,
          commandId: "app.deploy",
          error: {
            code: "APP.DEPLOY_FAILED",
            summary: "Deployment failed",
            why: "The compute service was not created",
          },
        },
      }),
    );

    expect(envelope).toMatchObject({
      ok: false,
      commandId: "app.deploy",
      error: { code: "APP.DEPLOY_FAILED" },
    });
  });
});

describe("PrismaCliCommandError", () => {
  test("exposes only stable structured fields for telemetry", () => {
    const error = new PrismaCliCommandError({
      message: "Deployment failed",
      command: "app.deploy",
      code: "APP.DEPLOY_FAILED",
    });

    expect(error).toMatchObject({
      name: "PrismaCliCommandError",
      message: "Deployment failed",
      prismaCliCommand: "app.deploy",
      prismaCliErrorCode: "APP.DEPLOY_FAILED",
    });
  });
});

describe("parseComposerDeployResult", () => {
  test("reads the official Composer deployment summary", () => {
    expect(
      parseComposerDeployResult({
        summary: {
          app: "my-app",
          nodes: [
            {
              address: "app",
              entities: [
                {
                  kind: "compute-service",
                  id: "cps_abc123",
                  url: "https://abc123.ewr.prisma.build/",
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      appName: "my-app",
      appUrl: "https://abc123.ewr.prisma.build",
      serviceId: "cps_abc123",
    });
  });

  test("keeps the app name when no compute URL was reported", () => {
    expect(
      parseComposerDeployResult({
        summary: {
          app: "worker",
          nodes: [{ address: "database", entities: [] }],
        },
      }),
    ).toEqual({ appName: "worker" });
  });

  test("returns undefined when Composer has no deployment summary", () => {
    expect(parseComposerDeployResult({ summary: null })).toBeUndefined();
  });
});

describe("deployNewProjectWithComposer", () => {
  test("reports interrupted sign-in as cancellation without hiding real login failures", async () => {
    const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    try {
      for (const exitCode of [130, 0xc000013a, 1]) {
        const output = new PassThrough();
        let text = "";
        output.on("data", (chunk) => {
          text += chunk.toString();
        });
        const result = await applicationRuntime.runPromiseExit(
          Effect.gen(function* () {
            const realRunner = yield* CommandRunner;
            return yield* deployNewProjectWithComposerEffect({
              appName: "test-app",
              packageManager: "npm",
              projectDir: process.cwd(),
              shouldPromptForWorkspace: false,
              verbose: false,
              output,
            }).pipe(
              Effect.provideService(CommandRunner, {
                run: (spec) => {
                  expect(spec.args).toContain("whoami");
                  return Effect.succeed({
                    exitCode: 0,
                    stdout: JSON.stringify({
                      ok: true,
                      result: { authenticated: false, workspace: null, source: null },
                    }),
                    stderr: "",
                  });
                },
                runChecked: (spec) => {
                  expect(spec.args).toContain("login");
                  if (exitCode === 0xc000013a && process.platform !== "win32") {
                    return Effect.fail(
                      new CommandExecutionError({
                        command: spec.command,
                        args: [...spec.args],
                        exitCode,
                        stdout: "",
                        stderr: "",
                        childProcessFailure: "interrupted",
                      }),
                    );
                  }
                  return realRunner.runChecked({
                    ...spec,
                    command: process.execPath,
                    args: ["-e", `process.exit(${exitCode})`],
                  });
                },
              }),
            );
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result)) throw new Error("Expected sign-in to stop deployment");
        const error = Cause.squash(result.cause);
        if (exitCode === 1) {
          expect(error).toBeInstanceOf(CreateFailure);
          expect(error).toMatchObject({
            stage: "authenticate",
            reason: "prisma_auth_command_failed",
          });
          expect(text).toContain("Deploy failed:");
        } else {
          expect(error).toBeInstanceOf(CreateCancellationError);
          expect(error).toMatchObject({ stage: "authenticate" });
          expect(text).toContain("Operation cancelled.");
          expect(text).not.toContain("Deployment failed");
          expect(text).not.toContain("Deploy failed:");
        }
      }
    } finally {
      if (originalTTY) Object.defineProperty(process.stdin, "isTTY", originalTTY);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });

  test("returns the authentication failure instead of swallowing it", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await deployNewProjectWithComposer({
        appName: "test-app",
        packageManager: "npm",
        projectDir: process.cwd(),
        shouldPromptForWorkspace: false,
        verbose: false,
        output: new PassThrough(),
        allowInteractiveLogin: false,
        json: true,
      });

      expect(result).toMatchObject({
        ok: false,
        stage: "authenticate",
        reason: "prisma_auth_command_failed",
      });
      if (result.ok || result.cancelled) throw new Error("Expected a classified failure.");
      expect(result.error).toBeDefined();
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
});
