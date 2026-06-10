import type { CreateTemplate, DatabaseProvider, PackageManager, SchemaPreset } from "../types";
import { renderTemplateTree, resolveTemplatesDir } from "./shared";

type CreateTemplateContext = {
  projectName: string;
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
  compute: boolean;
};

function getCreateTemplateDir(template: CreateTemplate): string {
  return resolveTemplatesDir(`templates/create/${template}`);
}

function createTemplateContext(
  projectName: string,
  provider: DatabaseProvider,
  schemaPreset: SchemaPreset,
  packageManager: PackageManager | undefined,
  compute: boolean,
): CreateTemplateContext {
  return {
    projectName,
    provider,
    schemaPreset,
    packageManager,
    compute,
  };
}

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
  compute?: boolean;
}): Promise<void> {
  const { projectDir, projectName, template, provider, schemaPreset, packageManager } = opts;
  const templateRoot = getCreateTemplateDir(template);
  const context = createTemplateContext(
    projectName,
    provider,
    schemaPreset,
    packageManager,
    opts.compute === true,
  );
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });
}
