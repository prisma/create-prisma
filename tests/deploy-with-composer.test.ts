import { describe, expect, test } from "bun:test";

import {
  findProjectNameCollisions,
  getConsoleProjectUrl,
  parseComposerDeployResult,
  parsePrismaCliEnvelope,
} from "../src/tasks/deploy-with-composer";

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
