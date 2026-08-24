import { describe, expect, test } from "bun:test";
import { execa } from "execa";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializeGitRepository } from "../src/tasks/initialize-git";

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: "create-prisma test",
  GIT_AUTHOR_EMAIL: "create-prisma@example.test",
  GIT_COMMITTER_NAME: "create-prisma test",
  GIT_COMMITTER_EMAIL: "create-prisma@example.test",
};

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "create-prisma-git-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("initializeGitRepository", () => {
  test("creates an initial commit containing the generated project", async () => {
    await withTempDirectory(async (projectDir) => {
      await writeFile(path.join(projectDir, "package.json"), '{"name":"app"}\n');

      const result = await initializeGitRepository(projectDir, gitIdentity);

      expect(result).toEqual({ status: "initialized" });
      expect(
        (
          await execa("git", ["log", "-1", "--pretty=%s"], {
            cwd: projectDir,
            env: gitIdentity,
          })
        ).stdout,
      ).toBe("Initial commit from create-prisma");
      expect(
        (
          await execa("git", ["status", "--porcelain"], {
            cwd: projectDir,
            env: gitIdentity,
          })
        ).stdout,
      ).toBe("");
    });
  });

  test("does not create a nested repository inside an existing checkout", async () => {
    await withTempDirectory(async (repositoryDir) => {
      await execa("git", ["init"], { cwd: repositoryDir, env: gitIdentity });
      await writeFile(path.join(repositoryDir, "README.md"), "# repository\n");
      await execa("git", ["add", "--all"], { cwd: repositoryDir, env: gitIdentity });
      await execa("git", ["commit", "--no-verify", "-m", "Existing commit"], {
        cwd: repositoryDir,
        env: gitIdentity,
      });
      const projectDir = path.join(repositoryDir, "apps", "new-app");
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, "package.json"), '{"name":"new-app"}\n');

      const result = await initializeGitRepository(projectDir, gitIdentity);

      expect(result).toEqual({ status: "already-in-repository" });
      expect(await fsExists(path.join(projectDir, ".git"))).toBe(false);
    });
  });
});

async function fsExists(filePath: string): Promise<boolean> {
  return await Bun.file(filePath).exists();
}
