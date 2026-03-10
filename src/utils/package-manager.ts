import fs from "fs-extra";
import path from "node:path";

import { dependencyVersionMap } from "../constants/dependencies";
import {
  PackageManagerSchema,
  type PackageManager,
} from "../types";

type CommandAndArgs = {
  command: string;
  args: string[];
};

const packageManagerManifestValues = {
  npm: "npm@10.9.0",
  pnpm: "pnpm@10.16.1",
  yarn: "yarn@4.13.0",
  bun: "bun@1.3.9",
} as const;

function parseUserAgent(userAgent: string | undefined): PackageManager | null {
  if (userAgent?.startsWith("pnpm")) {
    return "pnpm";
  }

  if (userAgent?.startsWith("yarn")) {
    return "yarn";
  }

  if (userAgent?.startsWith("bun")) {
    return "bun";
  }

  if (userAgent?.startsWith("deno")) {
    return "deno";
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

async function detectFromDenoConfig(
  projectDir: string
): Promise<PackageManager | null> {
  const configCandidates = ["deno.json", "deno.jsonc"];

  for (const configFile of configCandidates) {
    if (await fs.pathExists(path.join(projectDir, configFile))) {
      return "deno";
    }
  }

  return null;
}

async function detectFromLockfile(
  projectDir: string
): Promise<PackageManager | null> {
  const lockfileChecks: Array<{ manager: PackageManager; lockfile: string }> = [
    { manager: "pnpm", lockfile: "pnpm-lock.yaml" },
    { manager: "yarn", lockfile: "yarn.lock" },
    { manager: "bun", lockfile: "bun.lockb" },
    { manager: "bun", lockfile: "bun.lock" },
    { manager: "npm", lockfile: "package-lock.json" },
    { manager: "npm", lockfile: "npm-shrinkwrap.json" },
    { manager: "deno", lockfile: "deno.lock" },
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

  const fromDenoConfig = await detectFromDenoConfig(projectDir);
  if (fromDenoConfig) {
    return fromDenoConfig;
  }

  const fromUserAgent = parseUserAgent(process.env.npm_config_user_agent);
  if (fromUserAgent) {
    return fromUserAgent;
  }

  return "npm";
}

export function getPackageManagerManifestValue(
  packageManager: PackageManager | undefined
): string | undefined {
  if (!packageManager || packageManager === "deno") {
    return undefined;
  }

  return packageManagerManifestValues[packageManager];
}

export function getDenoPrismaSpecifier(): string {
  const prismaVersion = dependencyVersionMap.prisma.replace(/^[^0-9]*/, "");
  return `npm:prisma@${prismaVersion}`;
}

export function getInstallCommand(packageManager: PackageManager): string {
  if (packageManager === "deno") {
    return "deno install --allow-scripts";
  }

  return `${packageManager} install`;
}

export function getPrismaSeedCommand(
  packageManager: PackageManager | undefined
): string {
  switch (packageManager) {
    case "deno":
      return "deno run -A prisma/seed.ts";
    case "bun":
      return "bun prisma/seed.ts";
    case "pnpm":
    case "yarn":
    case "npm":
    default:
      return "tsx prisma/seed.ts";
  }
}

export function getRunScriptCommand(
  packageManager: PackageManager,
  scriptName: string
): string {
  switch (packageManager) {
    case "deno":
      return `deno task ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn run ${scriptName}`;
    case "npm":
    default:
      return `npm run ${scriptName}`;
  }
}

export function getInstallArgs(
  packageManager: PackageManager
): CommandAndArgs {
  if (packageManager === "deno") {
    return {
      command: "deno",
      args: ["install", "--allow-scripts"],
    };
  }

  return {
    command: packageManager,
    args: ["install"],
  };
}

export function getPackageExecutionArgs(
  packageManager: PackageManager,
  commandArgs: string[]
): CommandAndArgs {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", ...commandArgs] };
    case "yarn":
      return { command: "yarn", args: ["dlx", ...commandArgs] };
    case "bun":
      return { command: "bunx", args: [...commandArgs] };
    case "deno": {
      const [packageName, ...args] = commandArgs;
      if (!packageName) {
        throw new Error("Package execution requires a package name.");
      }

      return {
        command: "deno",
        args: ["run", "-A", `npm:${packageName}`, ...args],
      };
    }
    case "npm":
    default:
      return { command: "npx", args: [...commandArgs] };
  }
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

  if (packageManager === "deno") {
    return {
      command: "deno",
      args: ["run", "-A", getDenoPrismaSpecifier(), ...prismaArgs],
    };
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
