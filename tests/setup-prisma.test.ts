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
  test("--yes provisions Prisma Postgres by default for PostgreSQL", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        {
          yes: true,
          provider: "postgres",
          packageManager: "bun",
          install: false,
        },
        { projectDir },
      );

      expect(context?.shouldUsePrismaPostgres).toBe(true);
    });
  });

  test("--yes does not provision Prisma Postgres when DATABASE_URL is supplied", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        {
          yes: true,
          provider: "postgres",
          databaseUrl: "postgresql://user:password@localhost:5432/mydb",
          packageManager: "bun",
          install: false,
        },
        { projectDir },
      );

      expect(context?.shouldUsePrismaPostgres).toBe(false);
    });
  });

  test("--yes does not provision Prisma Postgres for MongoDB", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        {
          yes: true,
          provider: "mongo",
          packageManager: "bun",
          install: false,
        },
        { projectDir },
      );

      expect(context?.shouldUsePrismaPostgres).toBe(false);
    });
  });
});
