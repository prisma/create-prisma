import type {
  AuthoringStyle,
  CreateTemplate,
  DatabaseProvider,
  PackageManager,
  SchemaPreset,
} from "../types";
import { renderTemplateTree, resolveTemplatesDir } from "./shared";

type CreateTemplateContext = {
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
};

function getCreateTemplateDir(template: CreateTemplate): string {
  return resolveTemplatesDir(`templates/create/${template}`);
}

function getCreateSharedTemplateDir(): string {
  return resolveTemplatesDir("templates/create/_shared");
}

function createTemplateContext(
  projectName: string,
  template: CreateTemplate,
  provider: DatabaseProvider,
  authoring: AuthoringStyle,
  schemaPreset: SchemaPreset,
  packageManager?: PackageManager,
): CreateTemplateContext {
  return {
    projectName,
    template,
    provider,
    authoring,
    schemaPreset,
    packageManager,
  };
}

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
}): Promise<void> {
  const { projectDir, projectName, template, provider, authoring, schemaPreset, packageManager } =
    opts;
  const templateRoot = getCreateTemplateDir(template);
  const sharedTemplateRoot = getCreateSharedTemplateDir();
  const context = createTemplateContext(
    projectName,
    template,
    provider,
    authoring,
    schemaPreset,
    packageManager,
  );
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot: sharedTemplateRoot,
    outputDir: projectDir,
    context,
  });
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });
}
