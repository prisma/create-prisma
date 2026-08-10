import fs from "fs-extra";
import path from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";

import type { CreateTemplate, DatabaseProvider, PackageManager } from "../types";
import { escapeRegExp } from "../utils/regexp";
import { renderTemplateFile, renderTemplateTree, resolveTemplatesDir } from "./shared";

type CreateTemplateContext = {
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  packageManager?: PackageManager;
  composerPostgres: boolean;
};

const starterStyleOutputPaths: Partial<Record<CreateTemplate, string>> = {
  astro: "src/styles.css",
  next: "src/app/globals.css",
  nuxt: "app/assets/css/main.css",
  svelte: "src/app.css",
  "tanstack-start": "src/styles.css",
};

function getCreateTemplateDir(template: CreateTemplate): string {
  return resolveTemplatesDir(`templates/create/${template}`);
}

function createTemplateContext(
  projectName: string,
  template: CreateTemplate,
  provider: DatabaseProvider,
  packageManager: PackageManager | undefined,
  composerPostgres: boolean,
): CreateTemplateContext {
  return {
    projectName,
    template,
    provider,
    packageManager,
    composerPostgres,
  };
}

const pnpmAllowedBuilds = [
  "@prisma/engines",
  "@parcel/watcher",
  "esbuild",
  "msgpackr-extract",
  "prisma",
  "sharp",
  "unrs-resolver",
  "workerd",
] as const;

const composerEffectOverrides = {
  "@effect/platform-bun": "4.0.0-beta.93",
  "@effect/platform-node": "4.0.0-beta.93",
  "@effect/platform-node-shared": "4.0.0-beta.93",
  "@effect/sql-d1": "4.0.0-beta.93",
  "@effect/sql-pg": "4.0.0-beta.93",
  "@effect/vitest": "4.0.0-beta.93",
} as const;

function renderPnpmAllowBuildLine(packageName: string): string {
  const key = packageName.startsWith("@") ? JSON.stringify(packageName) : packageName;
  return `  ${key}: true`;
}

function renderPnpmAllowBuilds(): string {
  return ["allowBuilds:", ...pnpmAllowedBuilds.map(renderPnpmAllowBuildLine)].join("\n");
}

function hasPnpmAllowBuild(content: string, packageName: string): boolean {
  const key = escapeRegExp(packageName);
  return new RegExp(`^\\s*["']?${key}["']?\\s*:\\s*true\\s*$`, "m").test(content);
}

function mergePnpmAllowBuilds(content: string): string {
  const missingBuilds = pnpmAllowedBuilds.filter(
    (packageName) => !hasPnpmAllowBuild(content, packageName),
  );
  if (missingBuilds.length === 0) {
    return content;
  }

  const missingLines = missingBuilds.map(renderPnpmAllowBuildLine);
  const trimmedContent = content.trimEnd();
  const lines = trimmedContent.length > 0 ? trimmedContent.split("\n") : [];
  const allowBuildsIndex = lines.findIndex((line) => /^allowBuilds:\s*$/.test(line));
  if (allowBuildsIndex === -1) {
    const allowBuilds = ["allowBuilds:", ...missingLines].join("\n");
    return trimmedContent.length > 0 ? `${trimmedContent}\n\n${allowBuilds}\n` : `${allowBuilds}\n`;
  }

  lines.splice(allowBuildsIndex + 1, 0, ...missingLines);
  return `${lines.join("\n")}\n`;
}

function mergePnpmComposerOverrides(content: string): string {
  const document = parseDocument(content);
  if (document.errors.length > 0) {
    throw new Error(`Could not update pnpm-workspace.yaml: ${document.errors[0]?.message}`);
  }

  if (!document.has("overrides")) {
    document.set("overrides", document.createNode({}));
  }
  let overrides = document.get("overrides", true);
  if (isScalar(overrides) && overrides.value === null) {
    document.set("overrides", document.createNode({}));
    overrides = document.get("overrides", true);
  }
  if (!isMap(overrides)) {
    throw new Error('Could not update pnpm-workspace.yaml: "overrides" must be a mapping.');
  }

  const missingOverrides = Object.entries(composerEffectOverrides).filter(
    ([packageName]) => !overrides.has(packageName),
  );
  if (missingOverrides.length === 0) return content;

  for (const [packageName, version] of missingOverrides) {
    overrides.set(packageName, version);
  }
  return document.toString();
}

async function ensurePnpmWorkspace(projectDir: string): Promise<void> {
  const workspacePath = path.join(projectDir, "pnpm-workspace.yaml");

  if (!(await fs.pathExists(workspacePath))) {
    const content = mergePnpmComposerOverrides(`${renderPnpmAllowBuilds()}\n`);
    await fs.writeFile(workspacePath, content, "utf8");
    return;
  }

  const existingContent = await fs.readFile(workspacePath, "utf8");
  const allowBuildsContent = mergePnpmAllowBuilds(existingContent);
  const nextContent = mergePnpmComposerOverrides(allowBuildsContent);
  if (nextContent !== existingContent) {
    await fs.writeFile(workspacePath, nextContent, "utf8");
  }
}

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  packageManager?: PackageManager;
  composerPostgres?: boolean;
}): Promise<void> {
  const { projectDir, projectName, template, provider, packageManager } = opts;
  const templateRoot = getCreateTemplateDir(template);
  const context = createTemplateContext(
    projectName,
    template,
    provider,
    packageManager,
    opts.composerPostgres === true,
  );
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });
  const starterStyleOutputPath = starterStyleOutputPaths[template];
  if (starterStyleOutputPath) {
    await renderTemplateFile<CreateTemplateContext>({
      templateFilePath: resolveTemplatesDir("templates/shared/starter.css"),
      outputPath: path.join(projectDir, starterStyleOutputPath),
      context,
    });
  }
  if (context.composerPostgres) {
    await renderTemplateFile<CreateTemplateContext>({
      templateFilePath: resolveTemplatesDir("templates/shared/setup-composer-postgres.mjs.hbs"),
      outputPath: path.join(projectDir, "scripts/setup-composer-postgres.mjs"),
      context,
    });
  }
  if (packageManager === "pnpm") {
    await ensurePnpmWorkspace(projectDir);
  }
}
