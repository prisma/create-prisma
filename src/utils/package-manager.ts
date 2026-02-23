import fs from "fs-extra";
import path from "node:path";

import {
  PackageManagerSchema,
  type PackageManager,
} from "../types";

type CommandAndArgs = {
  command: string;
  args: string[];
};

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
): CommandAndArgs {
  return {
    command: packageManager,
    args: ["install"],
  };
}

function getPackageExecutor(packageManager: PackageManager): CommandAndArgs {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx"] };
    case "bun":
      return { command: "bunx", args: [] };
    case "npm":
    default:
      return { command: "npx", args: [] };
  }
}

export function getPackageExecutionArgs(
  packageManager: PackageManager,
  commandArgs: string[]
): CommandAndArgs {
  const executor = getPackageExecutor(packageManager);
  return {
    command: executor.command,
    args: [...executor.args, ...commandArgs],
  };
}

export function getPackageExecutionCommand(
  packageManager: PackageManager,
  commandArgs: string[]
): string {
  const execution = getPackageExecutionArgs(packageManager, commandArgs);
  return [execution.command, ...execution.args].join(" ");
}

export function getPrismaCliArgs(
  packageManager: PackageManager,
  prismaArgs: string[]
): CommandAndArgs {
  if (packageManager === "bun") {
    return getPackageExecutionArgs(packageManager, [
      "--bun",
      "prisma",
      ...prismaArgs,
    ]);
  }

  return getPackageExecutionArgs(packageManager, ["prisma", ...prismaArgs]);
}

export function getPrismaCliCommand(
  packageManager: PackageManager,
  prismaArgs: string[]
): string {
  const execution = getPrismaCliArgs(packageManager, prismaArgs);
  return [execution.command, ...execution.args].join(" ");
}
