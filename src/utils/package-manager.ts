import fs from "fs-extra";
import path from "node:path";

import { dependencyVersionMap } from "../constants/dependencies";
import { PackageManagerSchema, type PackageManager } from "../types";

type CommandAndArgs = {
  command: string;
  args: string[];
};

type RuntimeScriptKind = "dev" | "build" | "start";
type RuntimeScriptOptions = {
  sourceEntrypoint: string;
  builtEntrypoint?: string;
  denoFlags?: string[];
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

function parsePackageManagerField(packageManagerField: unknown): PackageManager | null {
  if (typeof packageManagerField !== "string" || packageManagerField.length === 0) {
    return null;
  }

  const managerName = packageManagerField.split("@")[0];
  const parsed = PackageManagerSchema.safeParse(managerName);
  return parsed.success ? parsed.data : null;
}

async function detectFromPackageJson(projectDir: string): Promise<PackageManager | null> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return null;
  }

  const packageJson = await fs.readJson(packageJsonPath);
  return parsePackageManagerField(packageJson.packageManager);
}

async function detectFromDenoConfig(projectDir: string): Promise<PackageManager | null> {
  const configCandidates = ["deno.json", "deno.jsonc"];

  for (const configFile of configCandidates) {
    if (await fs.pathExists(path.join(projectDir, configFile))) {
      return "deno";
    }
  }

  return null;
}

async function detectFromLockfile(projectDir: string): Promise<PackageManager | null> {
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

export async function detectPackageManager(projectDir = process.cwd()): Promise<PackageManager> {
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
  packageManager: PackageManager | undefined,
): string | undefined {
  if (!packageManager || packageManager === "deno") {
    return undefined;
  }

  return packageManagerManifestValues[packageManager];
}

export function getDenoPrismaSpecifier(): string {
  return `npm:prisma@${dependencyVersionMap.prisma}`;
}

function getDenoAllowedScriptSpecifiers(): string {
  return [
    `npm:prisma@${dependencyVersionMap.prisma}`,
    `npm:@prisma/client@${dependencyVersionMap["@prisma/client"]}`,
    `npm:@prisma/engines@${dependencyVersionMap.prisma}`,
  ].join(",");
}

export function getInstallCommand(packageManager: PackageManager): string {
  if (packageManager === "deno") {
    return `deno install --allow-scripts=${getDenoAllowedScriptSpecifiers()}`;
  }

  return `${packageManager} install`;
}

export function getRunScriptCommand(packageManager: PackageManager, scriptName: string): string {
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

export function getRunScriptInDirectoryCommand(
  packageManager: PackageManager,
  directory: string,
  scriptName: string,
): string {
  switch (packageManager) {
    case "deno":
      return `deno task --cwd ${directory} ${scriptName}`;
    case "bun":
      return `bun run --cwd ${directory} ${scriptName}`;
    case "pnpm":
      return `pnpm --dir ${directory} run ${scriptName}`;
    case "yarn":
      return `yarn --cwd ${directory} run ${scriptName}`;
    case "npm":
    default:
      return `npm --prefix ${directory} run ${scriptName}`;
  }
}

function joinCommandParts(parts: Array<string | undefined>): string {
  return parts.filter((part) => typeof part === "string" && part.length > 0).join(" ");
}

export function getRuntimeScriptCommand(
  packageManager: PackageManager,
  kind: RuntimeScriptKind,
  options: RuntimeScriptOptions,
): string {
  const { sourceEntrypoint, builtEntrypoint, denoFlags = [] } = options;

  if (packageManager === "deno") {
    switch (kind) {
      case "dev":
        return joinCommandParts([
          "deno",
          "run",
          "-A",
          "--env-file=.env",
          ...denoFlags,
          "--watch",
          sourceEntrypoint,
        ]);
      case "build":
        return `deno check ${sourceEntrypoint}`;
      case "start":
        return joinCommandParts([
          "deno",
          "run",
          "-A",
          "--env-file=.env",
          ...denoFlags,
          sourceEntrypoint,
        ]);
    }
  }

  if (packageManager === "bun") {
    switch (kind) {
      case "dev":
        return `bun --watch ${sourceEntrypoint}`;
      case "build":
        return "tsc --noEmit";
      case "start":
        return `bun ${sourceEntrypoint}`;
    }
  }

  switch (kind) {
    case "dev":
      return `tsx watch ${sourceEntrypoint}`;
    case "build":
      return "tsc";
    case "start":
      return builtEntrypoint ? `node ${builtEntrypoint}` : `tsx ${sourceEntrypoint}`;
  }
}

export function getInstallArgs(packageManager: PackageManager): CommandAndArgs {
  if (packageManager === "deno") {
    return {
      command: "deno",
      args: ["install", `--allow-scripts=${getDenoAllowedScriptSpecifiers()}`],
    };
  }

  return {
    command: packageManager,
    args: ["install"],
  };
}

export function getPackageExecutionArgs(
  packageManager: PackageManager,
  commandArgs: string[],
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
  commandArgs: string[],
): string {
  const execution = getPackageExecutionArgs(packageManager, commandArgs);
  return [execution.command, ...execution.args].join(" ");
}

export function getPrismaCliArgs(
  packageManager: PackageManager,
  prismaArgs: string[],
): CommandAndArgs {
  if (packageManager === "bun") {
    return getPackageExecutionArgs(packageManager, ["--bun", "prisma", ...prismaArgs]);
  }

  if (packageManager === "deno") {
    return {
      command: "deno",
      args: ["run", "-A", "--env-file=.env", getDenoPrismaSpecifier(), ...prismaArgs],
    };
  }

  return getPackageExecutionArgs(packageManager, ["prisma", ...prismaArgs]);
}

export function getPrismaCliCommand(packageManager: PackageManager, prismaArgs: string[]): string {
  const execution = getPrismaCliArgs(packageManager, prismaArgs);
  return [execution.command, ...execution.args].join(" ");
}
