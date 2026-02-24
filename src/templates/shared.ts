import Handlebars from "handlebars";
import fs from "fs-extra";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

Handlebars.registerHelper("eq", (left: unknown, right: unknown) => left === right);

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
