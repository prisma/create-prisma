import fs from "fs-extra";
import path from "node:path";

export const prismaSingletonCandidates = [
  "src/lib/prisma.ts",
  "src/lib/prisma.server.ts",
  "src/lib/server/prisma.ts",
  "server/utils/prisma.ts",
  "src/client.ts",
] as const;

const clientGeneratorBlockRegex = /generator\s+client\s*\{([\s\S]*?)\}/m;
const outputDirectiveRegex = /^\s*output\s*=\s*["']([^"']+)["']/m;

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export async function resolvePrismaProjectDir(projectDir: string): Promise<string> {
  const monorepoDbDir = path.join(projectDir, "packages/db");
  if (await fs.pathExists(path.join(monorepoDbDir, "prisma/schema.prisma"))) {
    return monorepoDbDir;
  }

  return projectDir;
}

export async function findFirstExistingPath(
  baseDir: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const relativePath of candidates) {
    const absolutePath = path.join(baseDir, relativePath);
    if (await fs.pathExists(absolutePath)) {
      return absolutePath;
    }
  }

  return undefined;
}

export function inferGeneratedClientDir(singletonPath: string): string {
  const normalizedSingletonPath = toPosixPath(singletonPath).replace(/^\.\/+/, "");
  const segments = normalizedSingletonPath.split("/").filter(Boolean);
  const srcIndex = segments.indexOf("src");
  if (srcIndex !== -1) {
    return [...segments.slice(0, srcIndex + 1), "generated", "prisma"].join("/");
  }

  const serverIndex = segments.indexOf("server");
  if (serverIndex !== -1) {
    return [...segments.slice(0, serverIndex + 1), "generated", "prisma"].join("/");
  }

  return "src/generated/prisma";
}

export async function readGeneratedClientDirFromSchema(
  prismaProjectDir: string,
): Promise<string | undefined> {
  const schemaPath = path.join(prismaProjectDir, "prisma/schema.prisma");
  if (!(await fs.pathExists(schemaPath))) {
    return undefined;
  }

  const schemaContent = await fs.readFile(schemaPath, "utf8");
  const clientGeneratorBlock = schemaContent.match(clientGeneratorBlockRegex)?.[1];
  const outputDirective = clientGeneratorBlock?.match(outputDirectiveRegex)?.[1];
  if (!outputDirective) {
    return undefined;
  }

  return path.resolve(path.dirname(schemaPath), outputDirective);
}

export async function resolveGeneratedClientDirPath(
  prismaProjectDir: string,
  singletonPath?: string,
): Promise<string> {
  const existingGeneratedClientDir = await readGeneratedClientDirFromSchema(prismaProjectDir);
  if (existingGeneratedClientDir) {
    return existingGeneratedClientDir;
  }

  return path.join(prismaProjectDir, inferGeneratedClientDir(singletonPath ?? "src/lib/prisma.ts"));
}

export function getGeneratedClientIgnoreEntry(
  prismaProjectDir: string,
  generatedClientDir: string,
): string {
  const generatedRootDir = path.dirname(generatedClientDir);
  const relativeGeneratedRoot = toPosixPath(path.relative(prismaProjectDir, generatedRootDir));

  if (relativeGeneratedRoot.length === 0 || relativeGeneratedRoot.startsWith("..")) {
    return "src/generated";
  }

  return relativeGeneratedRoot;
}

export function getRelativePathFromBase(baseDir: string, targetPath: string): string {
  return toPosixPath(path.relative(baseDir, targetPath));
}
