import { Effect, FileSystem } from "effect";
import Handlebars from "handlebars";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applicationRuntime } from "../runtime";
import type { PackageManager } from "../types";
import {
  getPackageManagerManifestValue,
  getRuntimeScriptCommand,
  getRunScriptCommand,
} from "../utils/package-manager";

Handlebars.registerHelper("eq", (left: unknown, right: unknown) => left === right);
Handlebars.registerHelper(
  "runScriptCommand",
  (packageManager: PackageManager | undefined, scriptName: string) =>
    packageManager ? getRunScriptCommand(packageManager, scriptName) : "",
);
Handlebars.registerHelper(
  "packageManagerManifestValue",
  (packageManager: PackageManager | undefined) =>
    getPackageManagerManifestValue(packageManager) ?? "",
);
Handlebars.registerHelper(
  "runtimeScript",
  (
    packageManager: PackageManager | undefined,
    kind: "dev" | "build" | "start",
    sourceEntrypoint: string,
    builtEntrypoint: string | undefined,
    _options: Handlebars.HelperOptions,
  ) =>
    packageManager
      ? getRuntimeScriptCommand(packageManager, kind, { sourceEntrypoint, builtEntrypoint })
      : "",
);

export const findPackageRootEffect = Effect.fn("Templates.findPackageRoot")(function* (
  startDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  let currentDir = startDir;

  while (true) {
    if (yield* fs.exists(path.join(currentDir, "package.json"))) return currentDir;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return yield* Effect.fail(new Error(`Unable to locate package root from: ${startDir}`));
    }
    currentDir = parentDir;
  }
});

export const resolveTemplatesDirEffect = Effect.fn("Templates.resolveDirectory")(function* (
  relativeTemplatesDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const currentFilePath = fileURLToPath(import.meta.url);
  const packageRoot = yield* findPackageRootEffect(path.dirname(currentFilePath));
  const templatePath = path.join(packageRoot, relativeTemplatesDir);
  if (!(yield* fs.exists(templatePath))) {
    return yield* Effect.fail(new Error(`Template directory not found at: ${templatePath}`));
  }
  return templatePath;
});

const ensureTrailingNewline = (content: string) =>
  content.endsWith("\n") ? content : `${content}\n`;
const stripHbsExtension = (filePath: string) =>
  filePath.endsWith(".hbs") ? filePath.slice(0, -4) : filePath;

export const renderTemplateFileEffect = Effect.fn("Templates.renderFile")(function* <
  TContext,
>(opts: { templateFilePath: string; outputPath: string; context: TContext }) {
  const fs = yield* FileSystem.FileSystem;
  const templateContent = yield* fs.readFileString(opts.templateFilePath);
  const outputContent = yield* Effect.try({
    try: () =>
      opts.templateFilePath.endsWith(".hbs")
        ? Handlebars.compile<TContext>(templateContent, { noEscape: true, strict: true })(
            opts.context,
          )
        : templateContent,
    catch: (cause) => new Error(`Could not render ${opts.templateFilePath}`, { cause }),
  });
  if (opts.templateFilePath.endsWith(".hbs") && outputContent.trim().length === 0) return;

  yield* fs.makeDirectory(path.dirname(opts.outputPath), { recursive: true });
  yield* fs.writeFileString(opts.outputPath, ensureTrailingNewline(outputContent));
});

export const renderTemplateTreeEffect = Effect.fn("Templates.renderTree")(function* <
  TContext,
>(opts: { templateRoot: string; outputDir: string; context: TContext }) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(opts.templateRoot, { recursive: true });

  for (const relativePath of entries) {
    const templateFilePath = path.join(opts.templateRoot, relativePath);
    const info = yield* fs.stat(templateFilePath);
    if (info.type !== "File") continue;
    yield* renderTemplateFileEffect({
      templateFilePath,
      outputPath: path.join(opts.outputDir, stripHbsExtension(relativePath)),
      context: opts.context,
    });
  }
});

export function findPackageRoot(startDir: string): Promise<string> {
  return applicationRuntime.runPromise(findPackageRootEffect(startDir));
}

export function resolveTemplatesDir(relativeTemplatesDir: string): Promise<string> {
  return applicationRuntime.runPromise(resolveTemplatesDirEffect(relativeTemplatesDir));
}

export function renderTemplateFile<TContext>(opts: {
  templateFilePath: string;
  outputPath: string;
  context: TContext;
}): Promise<void> {
  return applicationRuntime.runPromise(renderTemplateFileEffect(opts));
}

export function renderTemplateTree<TContext>(opts: {
  templateRoot: string;
  outputDir: string;
  context: TContext;
}): Promise<void> {
  return applicationRuntime.runPromise(renderTemplateTreeEffect(opts));
}
