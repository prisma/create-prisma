import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CreatePromptContext } from "../src/commands/create";
import {
  DEFAULT_PRISMA_NEXT_SPEC,
  type ResolvedPrismaNextSpec,
} from "../src/constants/dependencies";
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

function makeCreateContext(
  prismaNextSpec: ResolvedPrismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
): CreatePromptContext {
  return {
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
      prismaNextSpec,
    },
  };
}

const createContext = makeCreateContext();

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
        "prisma-next-version-kind": "default",
        "prisma-next-version-spec": "latest",
      }),
    );
  });

  test("classifies a published Prisma Next version as npm-version", async () => {
    await trackCreateCompleted({
      input: { ...createInput, prismaNextVersion: "0.10.0" },
      context: makeCreateContext({ kind: "npm", spec: "0.10.0" }),
      durationMs: 1,
    });

    expect(trackCliTelemetry).toHaveBeenCalledWith(
      CREATE_PRISMA_NEXT_COMPLETED_EVENT,
      expect.objectContaining({
        "prisma-next-version-kind": "npm-version",
        "prisma-next-version-spec": "0.10.0",
      }),
    );
  });

  test("classifies a non-default dist-tag as npm-tag", async () => {
    await trackCreateCompleted({
      input: { ...createInput, prismaNextVersion: "dev" },
      context: makeCreateContext({ kind: "npm", spec: "dev" }),
      durationMs: 1,
    });

    expect(trackCliTelemetry).toHaveBeenCalledWith(
      CREATE_PRISMA_NEXT_COMPLETED_EVENT,
      expect.objectContaining({
        "prisma-next-version-kind": "npm-tag",
        "prisma-next-version-spec": "dev",
      }),
    );
  });

  test("classifies a pkg-pr-new spec and round-trips the ref in the spec field", async () => {
    await trackCreateCompleted({
      input: { ...createInput, prismaNextVersion: "pkg-pr-new:bad6795" },
      context: makeCreateContext({ kind: "pkg-pr-new", ref: "bad6795" }),
      durationMs: 1,
    });

    expect(trackCliTelemetry).toHaveBeenCalledWith(
      CREATE_PRISMA_NEXT_COMPLETED_EVENT,
      expect.objectContaining({
        "prisma-next-version-kind": "pkg-pr-new",
        "prisma-next-version-spec": "pkg-pr-new:bad6795",
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

  test("falls back to the raw input spec when no context is available on failure", async () => {
    await trackCreateFailed({
      input: { ...createInput, prismaNextVersion: "0.11.0-dev.9" },
      durationMs: 1,
      stage: "validate_input",
    });

    expect(trackCliTelemetry).toHaveBeenCalledWith(
      CREATE_PRISMA_NEXT_FAILED_EVENT,
      expect.objectContaining({
        "prisma-next-version-kind": "default",
        "prisma-next-version-spec": "0.11.0-dev.9",
      }),
    );
  });
});
