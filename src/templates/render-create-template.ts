import { Effect } from "effect";

import { applicationRuntime } from "../runtime";
import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "../types";
import { renderTemplateTreeEffect, resolveTemplatesDirEffect } from "./shared";

type CreateTemplateContext = {
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
  tsdownEntry: string | null;
};

export type ScaffoldCreateTemplateOptions = {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager?: PackageManager;
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
  },
);

export const scaffoldCreateTemplateEffect = Effect.fn("Templates.scaffold")(function* (
  options: ScaffoldCreateTemplateOptions,
) {
  yield* scaffoldCreateFrameworkTemplateEffect(options);
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
