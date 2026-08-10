import fs from "fs-extra";
import path from "node:path";

import type { CreateTemplate, DatabaseProvider, PackageManager, SchemaPreset } from "../types";
import { escapeRegExp } from "../utils/regexp";
import { renderTemplateTree, resolveTemplatesDir } from "./shared";

type CreateTemplateContext = {
  projectName: string;
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
  composer: boolean;
  composerPostgres: boolean;
};

function getCreateTemplateDir(template: CreateTemplate): string {
  return resolveTemplatesDir(`templates/create/${template}`);
}

function createTemplateContext(
  projectName: string,
  provider: DatabaseProvider,
  schemaPreset: SchemaPreset,
  packageManager: PackageManager | undefined,
  composer: boolean,
  composerPostgres: boolean,
): CreateTemplateContext {
  return {
    projectName,
    provider,
    schemaPreset,
    packageManager,
    composer,
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
  const missingOverrides = Object.entries(composerEffectOverrides).filter(
    ([packageName]) =>
      !new RegExp(`^\\s*${escapeRegExp(JSON.stringify(packageName))}\\s*:`, "m").test(content),
  );
  if (missingOverrides.length === 0) return content;

  const missingLines = missingOverrides.map(
    ([packageName, version]) => `  ${JSON.stringify(packageName)}: ${version}`,
  );
  const trimmedContent = content.trimEnd();
  const lines = trimmedContent.length > 0 ? trimmedContent.split("\n") : [];
  const overridesIndex = lines.findIndex((line) => /^overrides:\s*$/.test(line));
  if (overridesIndex === -1) {
    return `${trimmedContent}\n\noverrides:\n${missingLines.join("\n")}\n`;
  }

  lines.splice(overridesIndex + 1, 0, ...missingLines);
  return `${lines.join("\n")}\n`;
}

async function ensurePnpmWorkspace(projectDir: string, composer: boolean): Promise<void> {
  const workspacePath = path.join(projectDir, "pnpm-workspace.yaml");

  if (!(await fs.pathExists(workspacePath))) {
    const content = composer
      ? mergePnpmComposerOverrides(`${renderPnpmAllowBuilds()}\n`)
      : `${renderPnpmAllowBuilds()}\n`;
    await fs.writeFile(workspacePath, content, "utf8");
    return;
  }

  const existingContent = await fs.readFile(workspacePath, "utf8");
  const allowBuildsContent = mergePnpmAllowBuilds(existingContent);
  const nextContent = composer
    ? mergePnpmComposerOverrides(allowBuildsContent)
    : allowBuildsContent;
  if (nextContent !== existingContent) {
    await fs.writeFile(workspacePath, nextContent, "utf8");
  }
}

export async function scaffoldCreateTemplate(opts: {
  projectDir: string;
  projectName: string;
  template: CreateTemplate;
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
  composer?: boolean;
  composerPostgres?: boolean;
}): Promise<void> {
  const { projectDir, projectName, template, provider, schemaPreset, packageManager } = opts;
  const templateRoot = getCreateTemplateDir(template);
  const context = createTemplateContext(
    projectName,
    provider,
    schemaPreset,
    packageManager,
    opts.composer === true,
    opts.composerPostgres === true,
  );
  await renderTemplateTree<CreateTemplateContext>({
    templateRoot,
    outputDir: projectDir,
    context,
  });
  if (packageManager === "pnpm") {
    await ensurePnpmWorkspace(projectDir, opts.composer === true);
  }
}
