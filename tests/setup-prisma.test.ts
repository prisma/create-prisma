import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectPrismaSetupContext } from "../src/tasks/setup-prisma";

async function withTempProject<T>(run: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-setup-"));
  try {
    return await run(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

describe("collectPrismaSetupContext", () => {
  test("--yes uses Prisma Postgres defaults without deploying", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, packageManager: "bun" },
        { projectDir },
      );

      expect(context).toMatchObject({
        databaseProvider: "postgres",
        authoring: "psl",
        packageManager: "bun",
        shouldDeploy: false,
        shouldPromptForWorkspace: false,
      });
    });
  });

  test("honors an explicit immediate deployment", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, packageManager: "pnpm", deploy: true },
        { projectDir },
      );
      expect(context?.shouldDeploy).toBe(true);
    });
  });

  test("preserves an explicit workspace for unattended deployment", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        {
          yes: true,
          packageManager: "pnpm",
          deploy: true,
          workspace: "workspace_123",
        },
        { projectDir },
      );
      expect(context).toMatchObject({
        shouldPromptForWorkspace: false,
        workspace: "workspace_123",
      });
    });
  });

  test("allows workspace selection during an interactive deployment", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        {
          provider: "postgres",
          authoring: "psl",
          packageManager: "bun",
          deploy: true,
        },
        { projectDir },
      );
      expect(context.shouldPromptForWorkspace).toBe(true);
    });
  });

  test("keeps MongoDB as an explicit provider option", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, provider: "mongo", packageManager: "npm" },
        { projectDir },
      );
      expect(context?.databaseProvider).toBe("mongo");
    });
  });
});
