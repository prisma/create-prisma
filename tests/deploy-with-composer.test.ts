import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  deployNewProjectWithComposer,
  findProjectNameCollisions,
  getConsoleProjectUrl,
  parseComposerDeployResult,
  parsePrismaCliEnvelope,
  PrismaCliCommandError,
} from "../src/tasks/deploy-with-composer";
import { parseComposerDeployFailureCode } from "../src/tasks/composer/deploy-report";
import { getErrorMessage, redactSecrets } from "../src/utils/errors";
import {
  childProcessFailedResult,
  composerRunReport,
  runFakeComposerDeploy,
} from "./fixtures/composer-deploy";

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

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

describe("parseComposerDeployFailureCode", () => {
  test("reads the failure code and nothing else", () => {
    expect(
      parseComposerDeployFailureCode(
        composerRunReport({
          code: "DEPLOY.ENGINE_FAILED",
          message: "alchemy failed in /Users/jane/projects/my-app",
        }),
      ),
    ).toBe("DEPLOY.ENGINE_FAILED");
  });

  test("returns nothing for a successful run", () => {
    expect(parseComposerDeployFailureCode(composerRunReport(null))).toBeUndefined();
  });

  test("rejects reports it cannot trust", () => {
    const failure = { code: "DEPLOY.ENGINE_FAILED", message: "failed" };
    for (const report of [
      "",
      "not json",
      "null",
      JSON.stringify({ version: 2, failure }),
      JSON.stringify({ failure }),
      JSON.stringify({ version: 1, failure: { code: 42 } }),
      JSON.stringify({ version: 1 }),
    ]) {
      expect(parseComposerDeployFailureCode(report)).toBeUndefined();
    }
  });

  test("rejects codes outside the structured-code grammar", () => {
    for (const code of [
      "",
      "ENGINE_FAILED",
      "deploy.engine_failed",
      "DEPLOY.",
      ".FAILED",
      "DEPLOY.ENGINE FAILED",
      "DEPLOY.ENGINE_FAILED\nDATABASE_URL=postgresql://jane:hunter2@host/db",
      "DEPLOY./Users/jane/projects/my-app",
      "jane@EXAMPLE.COM",
      "HTTPS://REGISTRY.EXAMPLE.COM/TOKEN",
    ]) {
      expect(
        parseComposerDeployFailureCode(composerRunReport({ code, message: "failed" })),
      ).toBeUndefined();
    }
  });
});

describe("runComposerDeployEffect", () => {
  test("asks Composer for a run report without changing the deploy result", async () => {
    const deployment = { summary: { app: "my-app", nodes: [] } };
    const deploy = await runFakeComposerDeploy({
      result: {
        exitCode: 0,
        stdout: JSON.stringify({ kind: "result", envelope: { ok: true, result: deployment } }),
        stderr: "",
      },
      report: composerRunReport(null),
    });

    expect(deploy.result).toEqual(deployment);
    expect(deploy.specs).toHaveLength(1);
    expect(deploy.specs[0]?.args.slice(-6)).toEqual([
      "deploy",
      "module.ts",
      "--report",
      deploy.reportPath!,
      "--json",
      "--no-interactive",
    ]);
    expect(path.isAbsolute(deploy.reportPath!)).toBe(true);
  });

  test("carries Composer's failure code beside the generic CLI code", async () => {
    const deploy = await runFakeComposerDeploy({
      result: childProcessFailedResult,
      report: composerRunReport({
        code: "DEPLOY.ENGINE_FAILED",
        message: "alchemy failed in /Users/jane/projects/my-app",
      }),
    });

    expect(deploy.error).toBeInstanceOf(PrismaCliCommandError);
    expect(deploy.error).toMatchObject({
      message: "The delegated process exited with code 1.",
      prismaCliCommand: "deploy",
      prismaCliErrorCode: "CLI.CHILD_PROCESS_FAILED",
      prismaCliCauseCode: "DEPLOY.ENGINE_FAILED",
      exitCode: 1,
      childProcessFailure: "non_zero_exit",
    });
    expect(getErrorMessage(deploy.error)).toBe("The delegated process exited with code 1.");
    expect(JSON.stringify(deploy.error)).not.toContain("jane");
  });

  test("preserves the original error when the report is missing or invalid", async () => {
    for (const report of [undefined, "not json", composerRunReport(null)]) {
      const deploy = await runFakeComposerDeploy({
        result: childProcessFailedResult,
        ...(report === undefined ? {} : { report }),
      });

      expect(deploy.error).toBeInstanceOf(PrismaCliCommandError);
      expect(deploy.error).toMatchObject({
        message: "The delegated process exited with code 1.",
        prismaCliErrorCode: "CLI.CHILD_PROCESS_FAILED",
        exitCode: 1,
      });
      expect(deploy.error).not.toHaveProperty("causeCode");
      expect((deploy.error as PrismaCliCommandError).prismaCliCauseCode).toBeUndefined();
    }
  });

  test("removes the report directory after success and failure", async () => {
    for (const result of [
      childProcessFailedResult,
      { exitCode: 0, stdout: '{"ok":true,"result":{"summary":null}}', stderr: "" },
    ]) {
      const deploy = await runFakeComposerDeploy({
        result,
        report: composerRunReport({ code: "DEPLOY.ENGINE_FAILED", message: "failed" }),
      });

      expect(deploy.reportPath).toBeDefined();
      expect(await pathExists(deploy.reportPath!)).toBe(false);
      expect(await pathExists(path.dirname(deploy.reportPath!))).toBe(false);
    }
  });
});

describe("deployNewProjectWithComposer", () => {
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
