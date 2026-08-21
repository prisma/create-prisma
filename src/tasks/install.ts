import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import {
  getCreateTemplateDependencies,
  getDependencyVersion,
  PRISMA_DENO_CLI_PACKAGE,
  PRISMA_PLATFORM_CLI_PACKAGE,
} from "../constants/dependencies";
import { getDbPackages } from "../constants/db-packages";
import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "../types";
import {
  getInstallArgs,
  getPackageExecutionCommand,
  getRunScriptCommand,
} from "../utils/package-manager";

function getPrismaScriptMap(packageManager: PackageManager): Record<string, string> {
  if (packageManager === "deno") {
    const prismaCommand = (needsDatabase: boolean, ...args: string[]) =>
      [
        "deno run -A",
        ...(needsDatabase ? ["--env-file=.env"] : []),
        `npm:${PRISMA_DENO_CLI_PACKAGE}`,
        ...args,
      ].join(" ");

    return {
      "contract:emit": prismaCommand(false, "contract", "emit"),
      "db:init": prismaCommand(true, "db", "init"),
      "db:update": prismaCommand(true, "db", "update"),
      "db:verify": prismaCommand(true, "db", "verify"),
      "migration:plan": prismaCommand(true, "migration", "plan"),
      migrate: prismaCommand(true, "migrate"),
      "migration:status": prismaCommand(true, "migration", "status"),
      "migration:show": prismaCommand(true, "migration", "show"),
    };
  }

  const prismaCommand = (...args: string[]) =>
    getPackageExecutionCommand(packageManager, [PRISMA_PLATFORM_CLI_PACKAGE, ...args]);

  return {
    "contract:emit": prismaCommand("contract", "emit"),
    "db:init": prismaCommand("db", "init"),
    "db:update": prismaCommand("db", "update"),
    "db:verify": prismaCommand("db", "verify"),
    "migration:plan": prismaCommand("migration", "plan"),
    migrate: prismaCommand("migrate"),
    "migration:status": prismaCommand("migration", "status"),
    "migration:show": prismaCommand("migration", "show"),
  };
}

export function getComposerScriptMap(packageManager: PackageManager): Record<string, string> {
  if (packageManager === "deno") {
    return {};
  }

  const composerCommand = (subcommand: string, extraArgs: string[] = []) =>
    getPackageExecutionCommand(packageManager, [
      PRISMA_PLATFORM_CLI_PACKAGE,
      "composer",
      subcommand,
      "module.ts",
      ...extraArgs,
    ]);

  return {
    "composer:dev": composerCommand("dev"),
    "composer:deploy": composerCommand("deploy"),
    "composer:destroy": composerCommand("destroy", ["--production"]),
    deploy: `${getRunScriptCommand(packageManager, "build")} && ${getRunScriptCommand(
      packageManager,
      "composer:deploy",
    )}`,
    "dev:composer": `${getRunScriptCommand(packageManager, "build")} && ${getRunScriptCommand(
      packageManager,
      "composer:dev",
    )}`,
  };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export async function addPackageDependency(opts: {
  dependencies?: string[];
  devDependencies?: string[];
  customDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  scriptMode?: "if-missing";
  projectDir: string;
}): Promise<void> {
  const {
    dependencies = [],
    devDependencies = [],
    customDependencies = {},
    scripts = {},
    scriptMode,
    projectDir,
  } = opts;

  const pkgJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(pkgJsonPath))) {
    throw new Error(
      `No package.json found in ${projectDir}. Run this command inside an existing JavaScript/TypeScript project.`,
    );
  }

  const pkgJson = await fs.readJson(pkgJsonPath);
  pkgJson.dependencies ??= {};
  pkgJson.devDependencies ??= {};
  pkgJson.scripts ??= {};

  for (const packageName of unique(dependencies)) {
    const version = getDependencyVersion(packageName);
    if (!version) throw new Error(`Dependency ${packageName} is missing from the version map.`);
    pkgJson.dependencies[packageName] = version;
  }
  for (const packageName of unique(devDependencies)) {
    const version = getDependencyVersion(packageName);
    if (!version) throw new Error(`Dependency ${packageName} is missing from the version map.`);
    pkgJson.devDependencies[packageName] = version;
  }
  for (const [packageName, version] of Object.entries(customDependencies)) {
    pkgJson.dependencies[packageName] = version;
  }
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (
      scriptMode === "if-missing" &&
      typeof pkgJson.scripts[scriptName] === "string" &&
      pkgJson.scripts[scriptName].trim().length > 0
    ) {
      continue;
    }
    pkgJson.scripts[scriptName] = command;
  }

  pkgJson.dependencies = sortRecord(pkgJson.dependencies);
  pkgJson.devDependencies = sortRecord(pkgJson.devDependencies);
  pkgJson.scripts = sortRecord(pkgJson.scripts);
  await fs.writeJson(pkgJsonPath, pkgJson, { spaces: 2 });
}

export async function writePrismaDependencies(
  provider: DatabaseProvider,
  packageManager: PackageManager,
  _authoring: AuthoringStyle,
  projectDir = process.cwd(),
): Promise<void> {
  const dependencies = [getDbPackages(provider)];
  if (provider === "mongo") dependencies.push("arktype", "mongodb");
  if (packageManager === "deno") dependencies.push("dotenv");

  const devDependencies =
    packageManager === "deno" ? ["@types/node"] : ["@prisma/cli-engine", "@types/node"];

  await addPackageDependency({
    dependencies,
    devDependencies,
    scripts: getPrismaScriptMap(packageManager),
    projectDir,
  });
}

export async function writeCreateTemplateDependencies(opts: {
  template: CreateTemplate;
  packageManager: PackageManager;
  projectDir?: string;
}): Promise<void> {
  const { template, packageManager, projectDir = process.cwd() } = opts;

  if (packageManager === "deno") {
    return;
  }

  for (const target of getCreateTemplateDependencies(template, packageManager)) {
    await addPackageDependency({
      dependencies: target.dependencies,
      devDependencies: target.devDependencies,
      customDependencies: target.customDependencies,
      scripts: getComposerScriptMap(packageManager),
      projectDir: path.join(projectDir, path.dirname(target.packageJsonPath)),
    });
  }

  const packageJsonPath = path.join(projectDir, "package.json");
  const packageJson = await fs.readJson(packageJsonPath);
  const effectVersion = getDependencyVersion("effect");
  if (!effectVersion) throw new Error("Dependency effect is missing from the version map.");

  if (packageManager === "yarn") {
    packageJson.resolutions = { ...packageJson.resolutions, effect: effectVersion };
  } else if (packageManager !== "pnpm") {
    packageJson.overrides = { ...packageJson.overrides, effect: effectVersion };
  }
  await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
}

export async function installProjectDependencies(
  packageManager: PackageManager,
  projectDir = process.cwd(),
  options: { verbose?: boolean } = {},
): Promise<void> {
  const installCommand = getInstallArgs(packageManager);
  const env =
    packageManager === "yarn"
      ? {
          YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
        }
      : undefined;

  await execa(installCommand.command, installCommand.args, {
    cwd: projectDir,
    env,
    stdio: options.verbose === true ? "inherit" : "pipe",
  });
}
