import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "../types";
import { renderTemplateTree, resolveTemplatesDir } from "./shared";

type CreateTemplateContext = {
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
  useLocalMongo: boolean;
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
  packageManager: PackageManager | undefined,
  useLocalMongo: boolean,
): CreateTemplateContext {
  return {
    projectName,
    template,
    provider,
    authoring,
    packageManager,
    useLocalMongo,
  };
}

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
  useLocalMongo: boolean;
}): Promise<void> {
  const { projectDir, projectName, template, provider, authoring, packageManager, useLocalMongo } =
    opts;
  const templateRoot = getCreateTemplateDir(template);
  const sharedTemplateRoot = getCreateSharedTemplateDir();
  const context = createTemplateContext(
    projectName,
    template,
    provider,
    authoring,
    packageManager,
    useLocalMongo,
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
