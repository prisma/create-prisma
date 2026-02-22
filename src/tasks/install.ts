import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import {
  dependencyVersionMap,
  type AvailableDependency,
} from "../constants/dependencies";
import { getDbPackages } from "../db/config";
import type { DatabaseProvider, PackageManager } from "../types";
import { getInstallArgs } from "../utils/package-manager";

export type DependencyWriteResult = {
  dependencies: string[];
  devDependencies: string[];
};

function getVersion(packageName: string): string | undefined {
  return dependencyVersionMap[packageName as AvailableDependency];
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  );
}

export async function addPackageDependency(opts: {
  dependencies?: string[];
  devDependencies?: string[];
  customDependencies?: Record<string, string>;
  customDevDependencies?: Record<string, string>;
  projectDir: string;
}): Promise<void> {
  const {
    dependencies = [],
    devDependencies = [],
    customDependencies = {},
    customDevDependencies = {},
    projectDir,
  } = opts;

  const pkgJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(pkgJsonPath))) {
    throw new Error(
      `No package.json found in ${projectDir}. Run this command inside an existing JavaScript/TypeScript project.`
    );
  }

  const pkgJson = await fs.readJson(pkgJsonPath);

  if (!pkgJson.dependencies) pkgJson.dependencies = {};
  if (!pkgJson.devDependencies) pkgJson.devDependencies = {};

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
      console.warn(
        `Warning: Dev dependency ${pkgName} not found in version map.`
      );
    }
  }

  for (const [pkgName, version] of Object.entries(customDependencies)) {
    pkgJson.dependencies[pkgName] = version;
  }

  for (const [pkgName, version] of Object.entries(customDevDependencies)) {
    pkgJson.devDependencies[pkgName] = version;
  }

  pkgJson.dependencies = sortRecord(pkgJson.dependencies);
  pkgJson.devDependencies = sortRecord(pkgJson.devDependencies);

  await fs.writeJson(pkgJsonPath, pkgJson, {
    spaces: 2,
  });
}

export async function writePrismaDependencies(
  provider: DatabaseProvider,
  projectDir = process.cwd()
): Promise<DependencyWriteResult> {
  const dependencies: string[] = ["@prisma/client", "dotenv"];
  const devDependencies: string[] = ["prisma"];
  const { adapterPackage } = getDbPackages(provider);
  dependencies.push(adapterPackage);

  await addPackageDependency({
    dependencies,
    devDependencies,
    projectDir,
  });

  return {
    dependencies,
    devDependencies,
  };
}

export async function installProjectDependencies(
  packageManager: PackageManager,
  projectDir = process.cwd()
): Promise<void> {
  const installCommand = getInstallArgs(packageManager);
  await execa(installCommand.command, installCommand.args, {
    cwd: projectDir,
    stdio: "inherit",
  });
}
