import Handlebars from "handlebars";
import fs from "fs-extra";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CreateTemplate, SchemaPreset } from "../types";

type CreateTemplateContext = {
  projectName: string;
  schemaPreset: SchemaPreset;
  useBasicSchema: boolean;
};

function findPackageRoot(startDir: string): string {
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

function getCreateTemplateDir(template: CreateTemplate): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(path.dirname(currentFilePath));
  const templatePath = path.join(packageRoot, "templates/create", template);

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
    })
  );

  return files.flat();
}

function stripHbsExtension(filePath: string): string {
  return filePath.endsWith(".hbs") ? filePath.slice(0, -4) : filePath;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function createTemplateContext(
  projectName: string,
  schemaPreset: SchemaPreset
): CreateTemplateContext {
  return {
    projectName,
    schemaPreset,
    useBasicSchema: schemaPreset === "basic",
  };
}

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  schemaPreset: SchemaPreset;
}): Promise<void> {
  const { projectDir, projectName, template, schemaPreset } = opts;
  const templateRoot = getCreateTemplateDir(template);
  const templateFiles = await getTemplateFilesRecursively(templateRoot);
  const context = createTemplateContext(projectName, schemaPreset);

  for (const templateFilePath of templateFiles) {
    const relativeTemplatePath = path.relative(templateRoot, templateFilePath);
    const relativeOutputPath = stripHbsExtension(relativeTemplatePath);
    const outputPath = path.join(projectDir, relativeOutputPath);
    const templateContent = await fs.readFile(templateFilePath, "utf8");
    const outputContent = relativeTemplatePath.endsWith(".hbs")
      ? Handlebars.compile<CreateTemplateContext>(templateContent, {
          noEscape: true,
          strict: true,
        })(context)
      : templateContent;

    await fs.outputFile(outputPath, ensureTrailingNewline(outputContent), "utf8");
  }
}
