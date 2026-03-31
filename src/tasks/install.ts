import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import { getDenoPrismaSpecifier, requiresDotenvConfigImport } from "../utils/package-manager";
import { dependencyVersionMap, type AvailableDependency } from "../constants/dependencies";
import { getDbPackages } from "../constants/db-packages";
import type { DatabaseProvider, DependencyWriteResult, PackageManager } from "../types";
import { getInstallArgs } from "../utils/package-manager";

function getPrismaScriptMap(packageManager: PackageManager) {
  if (packageManager === "deno") {
    const prismaSpecifier = getDenoPrismaSpecifier();

    return {
      "db:generate": `deno run -A --env-file=.env ${prismaSpecifier} generate`,
      "db:push": `deno run -A --env-file=.env ${prismaSpecifier} db push`,
      "db:migrate": `deno run -A --env-file=.env ${prismaSpecifier} migrate dev`,
      "db:seed": `deno run -A --env-file=.env ${prismaSpecifier} db seed`,
    } as const;
  }

  if (packageManager === "bun") {
    const prismaCli = "bun --env-file=.env ./node_modules/.bin/prisma";

    return {
      "db:generate": `${prismaCli} generate`,
      "db:push": `${prismaCli} db push`,
      "db:migrate": `${prismaCli} migrate dev`,
      "db:seed": `${prismaCli} db seed`,
    } as const;
  }

  return {
    "db:generate": "prisma generate",
    "db:push": "prisma db push",
    "db:migrate": "prisma migrate dev",
    "db:seed": "prisma db seed",
  } as const;
}

function getVersion(packageName: string): string | undefined {
  return dependencyVersionMap[packageName as AvailableDependency];
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

async function projectContainsText(projectDir: string, text: string): Promise<boolean> {
  const directories = [projectDir];

  while (directories.length > 0) {
    const currentDirectory = directories.pop();
    if (!currentDirectory) {
      continue;
    }

    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }

      const entryPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        directories.push(entryPath);
        continue;
      }

      if (!entry.isFile() || !/\.(c|m)?[jt]sx?$/.test(entry.name)) {
        continue;
      }

      const content = await fs.readFile(entryPath, "utf8");
      if (content.includes(text)) {
        return true;
      }
    }
  }

  return false;
}

function scriptUsesBinary(command: string, binaryName: string): boolean {
  return command.split(/\s+/).some((token) => {
    const normalizedToken = token.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
    return normalizedToken === binaryName || normalizedToken.endsWith(`/${binaryName}`);
  });
}

async function projectUsesScriptBinary(projectDir: string, binaryName: string): Promise<boolean> {
  const pkgJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(pkgJsonPath))) {
    return false;
  }

  const pkgJson = await fs.readJson(pkgJsonPath);
  const scripts = Object.values(pkgJson.scripts ?? {});
  return scripts.some(
    (script) => typeof script === "string" && scriptUsesBinary(script, binaryName),
  );
}

export async function addPackageDependency(opts: {
  dependencies?: string[];
  devDependencies?: string[];
  customDependencies?: Record<string, string>;
  customDevDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  scriptMode?: "if-missing" | "upsert";
  projectDir: string;
}): Promise<{
  addedScripts: string[];
  existingScripts: string[];
}> {
  const {
    dependencies = [],
    devDependencies = [],
    customDependencies = {},
    customDevDependencies = {},
    scripts = {},
    scriptMode = "upsert",
    projectDir,
  } = opts;
  const addedScripts: string[] = [];
  const existingScripts: string[] = [];

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
    const version = getVersion(pkgName);
    if (version) {
      pkgJson.dependencies[pkgName] = version;
    } else {
      console.warn(`Warning: Dependency ${pkgName} not found in version map.`);
    }
  }

  for (const pkgName of unique(devDependencies)) {
    const version = getVersion(pkgName);
    if (version) {
      pkgJson.devDependencies[pkgName] = version;
    } else {
      console.warn(`Warning: Dev dependency ${pkgName} not found in version map.`);
    }
  }

  for (const [pkgName, version] of Object.entries(customDependencies)) {
    pkgJson.dependencies[pkgName] = version;
  }

  for (const [pkgName, version] of Object.entries(customDevDependencies)) {
    pkgJson.devDependencies[pkgName] = version;
  }

  for (const [scriptName, command] of Object.entries(scripts)) {
    if (scriptMode === "if-missing") {
      if (
        typeof pkgJson.scripts[scriptName] !== "string" ||
        pkgJson.scripts[scriptName].trim().length === 0
      ) {
        pkgJson.scripts[scriptName] = command;
        addedScripts.push(scriptName);
      } else {
        existingScripts.push(scriptName);
      }
      continue;
    }

    if (pkgJson.scripts[scriptName] === command) {
      existingScripts.push(scriptName);
    } else {
      addedScripts.push(scriptName);
    }
    pkgJson.scripts[scriptName] = command;
  }

  pkgJson.dependencies = sortRecord(pkgJson.dependencies);
  pkgJson.devDependencies = sortRecord(pkgJson.devDependencies);

  await fs.writeJson(pkgJsonPath, pkgJson, {
    spaces: 2,
  });

  return {
    addedScripts,
    existingScripts,
  };
}

export async function writePrismaDependencies(
  provider: DatabaseProvider,
  packageManager: PackageManager,
  projectDir = process.cwd(),
): Promise<DependencyWriteResult> {
  const dependencies: string[] = ["@prisma/client"];
  const devDependencies: string[] = ["prisma"];
  const { adapterPackage } = getDbPackages(provider);
  dependencies.push(adapterPackage);

  if (
    requiresDotenvConfigImport(packageManager) ||
    (await projectContainsText(projectDir, "dotenv/config"))
  ) {
    dependencies.push("dotenv");
  }

  // Deno needs node-gyp available when sqlite pulls in better-sqlite3.
  if (provider === "sqlite" && packageManager === "deno") {
    devDependencies.push("node-gyp");
  }

  const prismaScriptMap = getPrismaScriptMap(packageManager);

  const scriptWriteResult = await addPackageDependency({
    dependencies,
    devDependencies,
    scripts: prismaScriptMap,
    scriptMode: "if-missing",
    projectDir,
  });

  return {
    dependencies,
    devDependencies,
    scripts: Object.keys(prismaScriptMap),
    addedScripts: scriptWriteResult.addedScripts,
    existingScripts: scriptWriteResult.existingScripts,
  };
}

export async function writeCreateTemplateDependencies(opts: {
  projectDir?: string;
}): Promise<void> {
  const { projectDir = process.cwd() } = opts;
  const devDependencies = (await projectUsesScriptBinary(projectDir, "tsx")) ? ["tsx"] : [];

  if (devDependencies.length === 0) {
    return;
  }

  await addPackageDependency({
    devDependencies,
    projectDir,
  });
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
  await execa(installCommand.command, installCommand.args, {
    cwd: projectDir,
    stdio: verbose ? "inherit" : "pipe",
  });
}
