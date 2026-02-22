import fs from "fs-extra";
import path from "node:path";

import {
  PackageManagerSchema,
  type PackageManager,
} from "../types";

function parseUserAgent(userAgent: string | undefined): PackageManager | null {
  if (userAgent?.startsWith("pnpm")) {
    return "pnpm";
  }

  if (userAgent?.startsWith("bun")) {
    return "bun";
  }

  if (userAgent?.startsWith("npm")) {
    return "npm";
  }

  return null;
}

function parsePackageManagerField(
  packageManagerField: unknown
): PackageManager | null {
  if (typeof packageManagerField !== "string" || packageManagerField.length === 0) {
    return null;
  }

  const managerName = packageManagerField.split("@")[0];
  const parsed = PackageManagerSchema.safeParse(managerName);
  return parsed.success ? parsed.data : null;
}

async function detectFromPackageJson(
  projectDir: string
): Promise<PackageManager | null> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return null;
  }

  const packageJson = await fs.readJson(packageJsonPath);
  return parsePackageManagerField(packageJson.packageManager);
}

async function detectFromLockfile(
  projectDir: string
): Promise<PackageManager | null> {
  const lockfileChecks: Array<{ manager: PackageManager; lockfile: string }> = [
    { manager: "pnpm", lockfile: "pnpm-lock.yaml" },
    { manager: "bun", lockfile: "bun.lockb" },
    { manager: "bun", lockfile: "bun.lock" },
    { manager: "npm", lockfile: "package-lock.json" },
    { manager: "npm", lockfile: "npm-shrinkwrap.json" },
  ];

  for (const check of lockfileChecks) {
    if (await fs.pathExists(path.join(projectDir, check.lockfile))) {
      return check.manager;
    }
  }

  return null;
}

export async function detectPackageManager(
  projectDir = process.cwd()
): Promise<PackageManager> {
  const fromPackageJson = await detectFromPackageJson(projectDir);
  if (fromPackageJson) {
    return fromPackageJson;
  }

  const fromLockfile = await detectFromLockfile(projectDir);
  if (fromLockfile) {
    return fromLockfile;
  }

  const fromUserAgent = parseUserAgent(process.env.npm_config_user_agent);
  if (fromUserAgent) {
    return fromUserAgent;
  }

  return "bun";
}

export function getInstallCommand(packageManager: PackageManager): string {
  return `${packageManager} install`;
}

export function getInstallArgs(
  packageManager: PackageManager
): { command: string; args: string[] } {
  return {
    command: packageManager,
    args: ["install"],
  };
}
