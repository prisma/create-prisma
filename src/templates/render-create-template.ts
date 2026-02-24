import type {
  CreateTemplate,
  CreateTemplateContext,
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
  schemaPreset: SchemaPreset,
  packageManager?: PackageManager
): CreateTemplateContext {
  return {
    projectName,
    schemaPreset,
    packageManager,
  };
}

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
}): Promise<void> {
  const { projectDir, projectName, template, schemaPreset, packageManager } = opts;
  const templateRoot = getCreateTemplateDir(template);
  const context = createTemplateContext(projectName, schemaPreset, packageManager);
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });
}
