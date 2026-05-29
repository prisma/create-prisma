import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import {
  DEFAULT_PRISMA_NEXT_SPEC,
  getCreateTemplateDependencies,
  getDependencyVersion,
  type ResolvedPrismaNextSpec,
} from "../constants/dependencies";
import { getDbPackages } from "../constants/db-packages";
import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "../types";
import { getDenoPrismaSpecifier, getInstallArgs } from "../utils/package-manager";

function getPrismaNextScriptMap(packageManager: PackageManager) {
  if (packageManager === "deno") {
    const prismaNextCli = `deno run -A --env-file=.env ${getDenoPrismaSpecifier()}`;

    return {
      "contract:emit": `${prismaNextCli} contract emit`,
      "db:init": `${prismaNextCli} db init`,
      "db:update": `${prismaNextCli} db update`,
      "db:verify": `${prismaNextCli} db verify`,
      "db:seed": "deno run -A --env-file=.env src/prisma/seed.ts",
      "migration:plan": `${prismaNextCli} migration plan`,
      migrate: `${prismaNextCli} migrate`,
      "migration:status": `${prismaNextCli} migration status`,
      "migration:show": `${prismaNextCli} migration show`,
    } as const;
  }

  if (packageManager === "bun") {
    const prismaNextCli = "bun prisma-next";

    return {
      "contract:emit": `${prismaNextCli} contract emit`,
      "db:init": `${prismaNextCli} db init`,
      "db:update": `${prismaNextCli} db update`,
      "db:verify": `${prismaNextCli} db verify`,
      "db:seed": "bun src/prisma/seed.ts",
      "migration:plan": `${prismaNextCli} migration plan`,
      migrate: `${prismaNextCli} migrate`,
      "migration:status": `${prismaNextCli} migration status`,
      "migration:show": `${prismaNextCli} migration show`,
    } as const;
  }

  return {
    "contract:emit": "prisma-next contract emit",
    "db:init": "prisma-next db init",
    "db:update": "prisma-next db update",
    "db:verify": "prisma-next db verify",
    "db:seed": "tsx src/prisma/seed.ts",
    "migration:plan": "prisma-next migration plan",
    migrate: "prisma-next migrate",
    "migration:status": "prisma-next migration status",
    "migration:show": "prisma-next migration show",
  } as const;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function getGeneratedContractTypePackages(provider: DatabaseProvider): string[] {
  if (provider === "mongo") {
    return ["@prisma-next/adapter-mongo", "@prisma-next/contract", "@prisma-next/mongo-contract"];
  }

  return [
    "@prisma-next/adapter-postgres",
    "@prisma-next/contract",
    "@prisma-next/sql-contract",
    "@prisma-next/target-postgres",
  ];
}

function getTypeScriptContractPackages(provider: DatabaseProvider): string[] {
  if (provider === "mongo") {
    return [
      ...getGeneratedContractTypePackages(provider),
      "@prisma-next/family-mongo",
      "@prisma-next/mongo-contract-ts",
      "@prisma-next/target-mongo",
    ];
  }

  return [
    ...getGeneratedContractTypePackages(provider),
    "@prisma-next/family-sql",
    "@prisma-next/sql-contract-ts",
  ];
}

function getMigrationPackages(provider: DatabaseProvider): string[] {
  if (provider === "mongo") {
    return ["@prisma-next/family-mongo", "@prisma-next/target-mongo"];
  }

  return ["@prisma-next/target-postgres"];
}

function getOrmTypePackages(provider: DatabaseProvider): string[] {
  if (provider === "mongo") {
    return ["@prisma-next/mongo-orm"];
  }

  return ["@prisma-next/sql-orm-client"];
}

export async function addPackageDependency(opts: {
  dependencies?: string[];
  devDependencies?: string[];
  customDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  scriptMode?: "if-missing";
  projectDir: string;
  prismaNextSpec?: ResolvedPrismaNextSpec;
}): Promise<void> {
  const {
    dependencies = [],
    devDependencies = [],
    customDependencies = {},
    scripts = {},
    scriptMode,
    projectDir,
    prismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
  } = opts;

  const pkgJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(pkgJsonPath))) {
    throw new Error(
      `No package.json found in ${projectDir}. Run this command inside an existing JavaScript/TypeScript project.`,
    );
  }

  const pkgJson = await fs.readJson(pkgJsonPath);

  if (!pkgJson.dependencies) pkgJson.dependencies = {};
  if (!pkgJson.devDependencies) pkgJson.devDependencies = {};
  if (!pkgJson.scripts) pkgJson.scripts = {};

  for (const pkgName of unique(dependencies)) {
    const version = getDependencyVersion(pkgName, prismaNextSpec);
    if (version) {
      pkgJson.dependencies[pkgName] = version;
    } else {
      console.warn(`Warning: Dependency ${pkgName} not found in version map.`);
    }
  }

  for (const pkgName of unique(devDependencies)) {
    const version = getDependencyVersion(pkgName, prismaNextSpec);
    if (version) {
      pkgJson.devDependencies[pkgName] = version;
    } else {
      console.warn(`Warning: Dev dependency ${pkgName} not found in version map.`);
    }
  }

  for (const [pkgName, version] of Object.entries(customDependencies)) {
    pkgJson.dependencies[pkgName] = version;
  }

  for (const [scriptName, command] of Object.entries(scripts)) {
    if (scriptMode === "if-missing") {
      if (
        typeof pkgJson.scripts[scriptName] !== "string" ||
        pkgJson.scripts[scriptName].trim().length === 0
      ) {
        pkgJson.scripts[scriptName] = command;
      }
      continue;
    }

    pkgJson.scripts[scriptName] = command;
  }

  pkgJson.dependencies = sortRecord(pkgJson.dependencies);
  pkgJson.devDependencies = sortRecord(pkgJson.devDependencies);

  await fs.writeJson(pkgJsonPath, pkgJson, {
    spaces: 2,
  });
}

export async function writePrismaDependencies(
  provider: DatabaseProvider,
  packageManager: PackageManager,
  authoring: AuthoringStyle,
  projectDir = process.cwd(),
  prismaNextSpec: ResolvedPrismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
): Promise<void> {
  const dependencies: string[] = [getDbPackages(provider, packageManager), "dotenv"];
  const devDependencies: string[] = ["prisma-next", "@prisma-next/cli", "@types/node"];
  devDependencies.push(...getGeneratedContractTypePackages(provider));
  devDependencies.push(...getMigrationPackages(provider));
  devDependencies.push(...getOrmTypePackages(provider));
  if (authoring === "typescript") {
    devDependencies.push(...getTypeScriptContractPackages(provider));
  }
  const prismaScriptMap = getPrismaNextScriptMap(packageManager);

  await addPackageDependency({
    dependencies,
    devDependencies,
    scripts: prismaScriptMap,
    projectDir,
    prismaNextSpec,
  });
}

export async function writeCreateTemplateDependencies(opts: {
  template: CreateTemplate;
  packageManager: PackageManager;
  projectDir?: string;
  prismaNextSpec?: ResolvedPrismaNextSpec;
}): Promise<void> {
  const {
    template,
    packageManager,
    projectDir = process.cwd(),
    prismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
  } = opts;
  const targets = getCreateTemplateDependencies(template, packageManager);

  for (const dependencyTarget of targets) {
    const targetDirectory = path.join(projectDir, path.dirname(dependencyTarget.packageJsonPath));

    await addPackageDependency({
      dependencies: dependencyTarget.dependencies,
      devDependencies: dependencyTarget.devDependencies,
      customDependencies: dependencyTarget.customDependencies,
      projectDir: targetDirectory,
      prismaNextSpec,
    });
  }
}

export async function installProjectDependencies(
  packageManager: PackageManager,
  projectDir = process.cwd(),
  options: {
    verbose?: boolean;
  } = {},
): Promise<void> {
  const verbose = options.verbose === true;
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
    stdio: verbose ? "inherit" : "pipe",
  });
}
