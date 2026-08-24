import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

export type GitInitializationResult =
  | { status: "initialized" }
  | { status: "already-in-repository" }
  | { status: "skipped"; reason: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Initializes a standalone scaffold as a Git repository and records its generated files.
 * Projects created inside an existing repository remain part of that repository.
 */
export async function initializeGitRepository(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitInitializationResult> {
  try {
    const existing = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectDir,
      env,
      reject: false,
    });
    if (existing.exitCode === 0 && existing.stdout.trim() === "true") {
      return { status: "already-in-repository" };
    }
  } catch (error) {
    return { status: "skipped", reason: errorMessage(error) };
  }

  let initialized = false;
  try {
    await execa("git", ["init"], { cwd: projectDir, env });
    initialized = true;
    await execa("git", ["add", "--all"], { cwd: projectDir, env });
    await execa("git", ["commit", "--no-verify", "-m", "Initial commit from create-prisma"], {
      cwd: projectDir,
      env,
    });
    return { status: "initialized" };
  } catch (error) {
    if (initialized) await fs.remove(path.join(projectDir, ".git"));
    return { status: "skipped", reason: errorMessage(error) };
  }
}
