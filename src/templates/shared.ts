import Handlebars from "handlebars";
import fs from "fs-extra";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PackageManager } from "../types";
import {
  getInstallCommand,
  getPackageManagerManifestValue,
  getRuntimeScriptCommand,
  getRunScriptCommand,
  requiresDotenvConfigImport,
} from "../utils/package-manager";

function getOptionalHashString(
  hash: Handlebars.HelperOptions["hash"],
  key: string,
): string | undefined {
  const value = hash[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getOptionalHashStringList(hash: Handlebars.HelperOptions["hash"], key: string): string[] {
  return getOptionalHashString(hash, key)?.split(" ") ?? [];
}

Handlebars.registerHelper("eq", (left: unknown, right: unknown) => left === right);
Handlebars.registerHelper("installCommand", (packageManager: PackageManager | undefined) =>
  packageManager ? getInstallCommand(packageManager) : "",
);
Handlebars.registerHelper(
  "runScriptCommand",
  (packageManager: PackageManager | undefined, scriptName: string) =>
    packageManager ? getRunScriptCommand(packageManager, scriptName) : "",
);
Handlebars.registerHelper(
  "packageManagerManifestValue",
  (packageManager: PackageManager | undefined) =>
    getPackageManagerManifestValue(packageManager) ?? "",
);
Handlebars.registerHelper(
  "requiresDotenvConfigImport",
  (packageManager: PackageManager | undefined) => requiresDotenvConfigImport(packageManager),
);
Handlebars.registerHelper(
  "runtimeScript",
  (
    packageManager: PackageManager | undefined,
    kind: "dev" | "build" | "start",
    sourceEntrypoint: string,
    builtEntrypoint: string | undefined,
    options: Handlebars.HelperOptions,
  ) => {
    if (!packageManager) {
      return "";
    }
    const hash = options.hash;

    return getRuntimeScriptCommand(packageManager, kind, {
      sourceEntrypoint,
      builtEntrypoint,
      denoFlags: getOptionalHashStringList(hash, "denoFlags"),
    });
  },
);

export function findPackageRoot(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  throw new Error(`Unable to locate package root from: ${startDir}`);
}

export function resolveTemplatesDir(relativeTemplatesDir: string): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(path.dirname(currentFilePath));
  const templatePath = path.join(packageRoot, relativeTemplatesDir);

  if (!existsSync(templatePath)) {
    throw new Error(`Template directory not found at: ${templatePath}`);
  }

  return templatePath;
}

async function getTemplateFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return getTemplateFilesRecursively(entryPath);
      }

      if (!entry.isFile()) {
        return [];
      }

      return [entryPath];
    }),
  );

  return files.flat();
}

function stripHbsExtension(filePath: string): string {
  return filePath.endsWith(".hbs") ? filePath.slice(0, -4) : filePath;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export async function renderTemplateFile<TContext>(opts: {
  templateFilePath: string;
  outputPath: string;
  context: TContext;
}): Promise<void> {
  const { templateFilePath, outputPath, context } = opts;
  const templateContent = await fs.readFile(templateFilePath, "utf8");
  const outputContent = templateFilePath.endsWith(".hbs")
    ? Handlebars.compile<TContext>(templateContent, {
        noEscape: true,
        strict: true,
      })(context)
    : templateContent;

  if (templateFilePath.endsWith(".hbs") && outputContent.trim().length === 0) {
    return;
  }

  await fs.outputFile(outputPath, ensureTrailingNewline(outputContent), "utf8");
}

export async function renderTemplateTree<TContext>(opts: {
  templateRoot: string;
  outputDir: string;
  context: TContext;
}): Promise<void> {
  const { templateRoot, outputDir, context } = opts;
  const templateFiles = await getTemplateFilesRecursively(templateRoot);

  for (const templateFilePath of templateFiles) {
    const relativeTemplatePath = path.relative(templateRoot, templateFilePath);
    const relativeOutputPath = stripHbsExtension(relativeTemplatePath);
    const outputPath = path.join(outputDir, relativeOutputPath);
    await renderTemplateFile({
      templateFilePath,
      outputPath,
      context,
    });
  }
}
