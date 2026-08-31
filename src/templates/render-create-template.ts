import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "../types";
import { renderTemplateTree, resolveTemplatesDir } from "./shared";

type CreateTemplateContext = {
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
  tsdownEntry: string | null;
};

const tsdownEntries: Partial<Record<CreateTemplate, string>> = {
  minimal: "src/index.ts",
  hono: "src/index.ts",
  elysia: "src/index.ts",
  nest: "src/main.ts",
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
  packageManager?: PackageManager,
): CreateTemplateContext {
  return {
    projectName,
    template,
    provider,
    authoring,
    packageManager,
    tsdownEntry: tsdownEntries[template] ?? null,
  };
}

export async function scaffoldCreateSharedTemplates(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
}): Promise<void> {
  const { projectDir, projectName, template, provider, authoring, packageManager } = opts;
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot: getCreateSharedTemplateDir(),
    outputDir: projectDir,
    context: createTemplateContext(projectName, template, provider, authoring, packageManager),
  });
}

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
}): Promise<void> {
  await scaffoldCreateFrameworkTemplate(opts);
  await scaffoldCreateSharedTemplates(opts);
}

export async function scaffoldCreateFrameworkTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
}): Promise<void> {
  const { projectDir, projectName, template, provider, authoring, packageManager } = opts;
  const templateRoot = getCreateTemplateDir(template);
  const context = createTemplateContext(projectName, template, provider, authoring, packageManager);
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });
}
