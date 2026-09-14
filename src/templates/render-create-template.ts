import { Effect } from "effect";
import path from "node:path";

import { applicationRuntime } from "../runtime";
import {
  agentSkillTargets,
  type AgentSkillTarget,
  type AuthoringStyle,
  type CreateTemplate,
  type DatabaseProvider,
  type PackageManager,
} from "../types";
import { renderTemplateTreeEffect, resolveTemplatesDirEffect } from "./shared";

const DEFAULT_PRISMA_SOURCE_DIR = "src/prisma";
const TURBOREPO_PRISMA_SOURCE_DIR = "packages/database/src";

export function getCreatePrismaSourceDir(template: CreateTemplate): string {
  return template === "turborepo" ? TURBOREPO_PRISMA_SOURCE_DIR : DEFAULT_PRISMA_SOURCE_DIR;
}

type CreateTemplateContext = {
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
  skillAgents: readonly AgentSkillTarget[];
  tsdownEntry: string | null;
};

export type ScaffoldCreateTemplateOptions = {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
  /** Agents whose skill files the project gets; defaults to all of them. */
  skillAgents?: readonly AgentSkillTarget[];
};

const tsdownEntries: Partial<Record<CreateTemplate, string>> = {
  minimal: "src/index.ts",
  hono: "src/index.ts",
  elysia: "src/index.ts",
  nest: "src/main.ts",
};

function createTemplateContext(options: ScaffoldCreateTemplateOptions): CreateTemplateContext {
  return {
    projectName: options.projectName,
    template: options.template,
    provider: options.provider,
    authoring: options.authoring,
    packageManager: options.packageManager,
    skillAgents: options.skillAgents ?? agentSkillTargets,
    tsdownEntry: tsdownEntries[options.template] ?? null,
  };
}

export const scaffoldCreateSharedTemplatesEffect = Effect.fn("Templates.scaffoldShared")(function* (
  options: ScaffoldCreateTemplateOptions,
) {
  const templateRoot = yield* resolveTemplatesDirEffect("templates/create/_shared");
  yield* renderTemplateTreeEffect({
    templateRoot,
    outputDir: options.projectDir,
    context: createTemplateContext(options),
    mapRelativeOutputPath(relativePath) {
      if (options.template !== "turborepo") return relativePath;
      const relativePrismaPath = path.relative(DEFAULT_PRISMA_SOURCE_DIR, relativePath);
      if (
        relativePrismaPath === ".." ||
        relativePrismaPath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePrismaPath)
      )
        return relativePath;
      return path.join(TURBOREPO_PRISMA_SOURCE_DIR, relativePrismaPath);
    },
  });
});

export const scaffoldCreatePackageManagerTemplatesEffect = Effect.fn(
  "Templates.scaffoldPackageManager",
)(function* (options: ScaffoldCreateTemplateOptions) {
  const templateRoot = yield* resolveTemplatesDirEffect("templates/create/_package-manager");
  yield* renderTemplateTreeEffect({
    templateRoot,
    outputDir: options.projectDir,
    context: createTemplateContext(options),
  });
});

export const scaffoldCreateFrameworkTemplateEffect = Effect.fn("Templates.scaffoldFramework")(
  function* (options: ScaffoldCreateTemplateOptions) {
    const templateRoot = yield* resolveTemplatesDirEffect(`templates/create/${options.template}`);
    yield* renderTemplateTreeEffect({
      templateRoot,
      outputDir: options.projectDir,
      context: createTemplateContext(options),
    });
    if (options.template === "turborepo") {
      const nextTemplateRoot = yield* resolveTemplatesDirEffect("templates/create/next");
      yield* renderTemplateTreeEffect({
        templateRoot: nextTemplateRoot,
        outputDir: path.join(options.projectDir, "apps/web"),
        context: createTemplateContext(options),
      });
    }
  },
);

export const scaffoldCreateTemplateEffect = Effect.fn("Templates.scaffold")(function* (
  options: ScaffoldCreateTemplateOptions,
) {
  yield* scaffoldCreateFrameworkTemplateEffect(options);
  yield* scaffoldCreatePackageManagerTemplatesEffect(options);
  yield* scaffoldCreateSharedTemplatesEffect(options);
});

export function scaffoldCreateSharedTemplates(
  options: ScaffoldCreateTemplateOptions,
): Promise<void> {
  return applicationRuntime.runPromise(scaffoldCreateSharedTemplatesEffect(options));
}

export function scaffoldCreateFrameworkTemplate(
  options: ScaffoldCreateTemplateOptions,
): Promise<void> {
  return applicationRuntime.runPromise(scaffoldCreateFrameworkTemplateEffect(options));
}

export function scaffoldCreateTemplate(options: ScaffoldCreateTemplateOptions): Promise<void> {
  return applicationRuntime.runPromise(scaffoldCreateTemplateEffect(options));
}
