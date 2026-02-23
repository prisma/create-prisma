import type { CreateTemplate, SchemaPreset } from "../types";
import {
  renderTemplateTree,
  resolveTemplatesDir,
} from "./shared";

type CreateTemplateContext = {
  projectName: string;
  schemaPreset: SchemaPreset;
  useBasicSchema: boolean;
};

function getCreateTemplateDir(template: CreateTemplate): string {
  return resolveTemplatesDir(`templates/create/${template}`);
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
  const context = createTemplateContext(projectName, schemaPreset);
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });
}
