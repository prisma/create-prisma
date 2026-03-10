import fs from "fs-extra";
import path from "node:path";

import type {
  DatabaseProvider,
  PackageManager,
  SchemaPreset,
} from "../types";
import {
  getRelativePathFromBase,
  resolveGeneratedClientDirPath,
} from "../utils/prisma-paths";
import {
  renderTemplateFile,
  resolveTemplatesDir,
} from "./shared";

type InitTemplateContext = {
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
  generatedClientOutputPath: string;
  generatedClientImportPath: string;
  singletonImportPathFromSeed: string;
};

const initTemplateRoot = resolveTemplatesDir("templates/init");

const staticInitTemplateFiles = [
  "prisma/schema.prisma.hbs",
  "prisma/seed.ts.hbs",
  "prisma.config.ts.hbs",
] as const;

function stripHbsExtension(filePath: string): string {
  return filePath.endsWith(".hbs") ? filePath.slice(0, -4) : filePath;
}

function toImportSpecifier(fromPath: string, toPath: string): string {
  const relativePath = path.relative(path.dirname(fromPath), toPath);
  const normalizedPath = relativePath.split(path.sep).join("/");
  const withoutExtension = normalizedPath.endsWith(".ts")
    ? normalizedPath.slice(0, -3)
    : normalizedPath;

  return withoutExtension.startsWith(".")
    ? withoutExtension
    : `./${withoutExtension}`;
}

export async function scaffoldInitTemplate(opts: {
  projectDir: string;
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
  singletonPath: string;
}): Promise<{
  writtenFiles: string[];
  skippedFiles: string[];
}> {
  const {
    projectDir,
    provider,
    schemaPreset,
    packageManager,
    singletonPath,
  } = opts;
  const singletonOutputPath = path.join(projectDir, singletonPath);
  const schemaOutputPath = path.join(projectDir, "prisma/schema.prisma");
  const generatedClientDirPath = await resolveGeneratedClientDirPath(
    projectDir,
    singletonPath
  );
  const generatedClientEntryPath = path.join(
    generatedClientDirPath,
    "client.ts"
  );
  const seedOutputPath = path.join(projectDir, "prisma/seed.ts");
  const context: InitTemplateContext = {
    provider,
    schemaPreset,
    packageManager,
    generatedClientOutputPath: getRelativePathFromBase(
      path.dirname(schemaOutputPath),
      generatedClientDirPath
    ),
    generatedClientImportPath: toImportSpecifier(
      singletonOutputPath,
      generatedClientEntryPath
    ),
    singletonImportPathFromSeed: toImportSpecifier(
      seedOutputPath,
      singletonOutputPath
    ),
  };
  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const relativeTemplatePath of staticInitTemplateFiles) {
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

  const singletonTemplatePath = path.join(
    initTemplateRoot,
    "prisma-instance.ts.hbs"
  );
  if (await fs.pathExists(singletonOutputPath)) {
    skippedFiles.push(singletonOutputPath);
  } else {
    await renderTemplateFile({
      templateFilePath: singletonTemplatePath,
      outputPath: singletonOutputPath,
      context,
    });
    if (await fs.pathExists(singletonOutputPath)) {
      writtenFiles.push(singletonOutputPath);
    }
  }

  return {
    writtenFiles,
    skippedFiles,
  };
}
