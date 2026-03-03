import type {
  CreateTemplate,
  CreateTemplateContext,
  DatabaseProvider,
  PackageManager,
  SchemaPreset,
} from "../types";
import {
  renderTemplateTree,
  resolveTemplatesDir,
} from "./shared";

function getCreateTemplateDir(template: CreateTemplate): string {
  return resolveTemplatesDir(`templates/create/${template}`);
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

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
}): Promise<void> {
  const {
    projectDir,
    projectName,
    template,
    provider,
    schemaPreset,
    packageManager,
  } = opts;
  const templateRoot = getCreateTemplateDir(template);
  const context = createTemplateContext(
    projectName,
    provider,
    schemaPreset,
    packageManager
  );
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });
}
