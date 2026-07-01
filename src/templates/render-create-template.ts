import fs from "fs-extra";
import path from "node:path";

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

const pnpmAllowedBuilds = [
  "@prisma/engines",
  "@parcel/watcher",
  "esbuild",
  "prisma",
  "sharp",
  "unrs-resolver",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

async function ensurePnpmWorkspaceAllowBuilds(projectDir: string): Promise<void> {
  const workspacePath = path.join(projectDir, "pnpm-workspace.yaml");

  if (!(await fs.pathExists(workspacePath))) {
    await fs.writeFile(workspacePath, `${renderPnpmAllowBuilds()}\n`, "utf8");
    return;
  }

  const existingContent = await fs.readFile(workspacePath, "utf8");
  const nextContent = mergePnpmAllowBuilds(existingContent);
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
  if (packageManager === "pnpm") {
    await ensurePnpmWorkspaceAllowBuilds(projectDir);
  }
}
