import path from "node:path";

import type {
  DatabaseProvider,
  InitTemplateContext,
  ScaffoldedInitTemplatePaths,
  SchemaPreset,
} from "../types";
import {
  renderTemplateTree,
  resolveTemplatesDir,
} from "./shared";

function getInitTemplatesDir(): string {
  return resolveTemplatesDir("templates/init");
}

function createTemplateContext(
  provider: DatabaseProvider,
  envVar: string,
  schemaPreset: SchemaPreset
): InitTemplateContext {
  return {
    envVar,
    provider,
    schemaPreset,
  };
}

export async function scaffoldInitTemplates(
  projectDir: string,
  provider: DatabaseProvider,
  envVar = "DATABASE_URL",
  schemaPreset: SchemaPreset = "empty"
): Promise<ScaffoldedInitTemplatePaths> {
  const templateRoot = getInitTemplatesDir();
  const context = createTemplateContext(provider, envVar, schemaPreset);
  await renderTemplateTree<InitTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });

  return {
    schemaPath: path.join(projectDir, "prisma/schema.prisma"),
    configPath: path.join(projectDir, "prisma.config.ts"),
    singletonPath: path.join(projectDir, "prisma/index.ts"),
  };
}
