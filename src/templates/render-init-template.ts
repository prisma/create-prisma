import fs from "fs-extra";
import path from "node:path";

import type {
  CreateTemplateContext,
  DatabaseProvider,
  PackageManager,
  SchemaPreset,
} from "../types";
import {
  renderTemplateFile,
  resolveTemplatesDir,
} from "./shared";

const initTemplateFiles = [
  "prisma/schema.prisma.hbs",
  "prisma/seed.ts.hbs",
  "prisma.config.ts",
  "src/lib/prisma.ts.hbs",
] as const;
const initTemplateRoot = resolveTemplatesDir("templates/create/hono");

function stripHbsExtension(filePath: string): string {
  return filePath.endsWith(".hbs") ? filePath.slice(0, -4) : filePath;
}

function createTemplateContext(
  projectName: string,
  provider: DatabaseProvider,
  schemaPreset: SchemaPreset,
  packageManager?: PackageManager
): CreateTemplateContext {
  return {
    projectName,
    provider,
    schemaPreset,
    packageManager,
  };
}

export async function scaffoldInitTemplate(opts: {
  projectDir: string;
  projectName: string;
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
}): Promise<{
  writtenFiles: string[];
  skippedFiles: string[];
}> {
  const {
    projectDir,
    projectName,
    provider,
    schemaPreset,
    packageManager,
  } = opts;
  const context = createTemplateContext(
    projectName,
    provider,
    schemaPreset,
    packageManager
  );
  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const relativeTemplatePath of initTemplateFiles) {
    const templateFilePath = path.join(initTemplateRoot, relativeTemplatePath);
    const outputPath = path.join(
      projectDir,
      stripHbsExtension(relativeTemplatePath)
    );

    if (await fs.pathExists(outputPath)) {
      skippedFiles.push(outputPath);
      continue;
    }

    await renderTemplateFile({
      templateFilePath,
      outputPath,
      context,
    });
    if (await fs.pathExists(outputPath)) {
      writtenFiles.push(outputPath);
    }
  }

  return {
    writtenFiles,
    skippedFiles,
  };
}
