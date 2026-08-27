import path from "node:path";

import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "../types";
import { renderTemplateTree, resolveTemplatesDir } from "./shared";

const DEFAULT_PRISMA_SOURCE_DIR = "src/prisma";
const TURBOREPO_PRISMA_SOURCE_DIR = "packages/database/src";

type CreateTemplateContext = {
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
};

function getCreateTemplateDir(template: CreateTemplate): string {
  return resolveTemplatesDir(`templates/create/${template}`);
}

function getCreateSharedTemplateDir(): string {
  return resolveTemplatesDir("templates/create/_shared");
}

export function getCreatePrismaSourceDir(template: CreateTemplate): string {
  return template === "turborepo" ? TURBOREPO_PRISMA_SOURCE_DIR : DEFAULT_PRISMA_SOURCE_DIR;
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
    mapRelativeOutputPath(relativePath) {
      if (template !== "turborepo") return relativePath;
      const relativePrismaPath = path.relative(DEFAULT_PRISMA_SOURCE_DIR, relativePath);
      if (
        relativePrismaPath === "" ||
        relativePrismaPath === ".." ||
        relativePrismaPath.startsWith(`..${path.sep}`)
      ) {
        return relativePath;
      }
      return path.join(TURBOREPO_PRISMA_SOURCE_DIR, relativePrismaPath);
    },
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
  if (template === "turborepo") {
    await renderTemplateTree<CreateTemplateContext>({
      templateRoot: getCreateTemplateDir("next"),
      outputDir: path.join(projectDir, "apps/web"),
      context,
    });
  }
}
