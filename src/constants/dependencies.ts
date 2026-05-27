import type { CreateTemplate, PackageManager } from "../types";
import { usesNodeStyleRuntime } from "../utils/runtime";

export const dependencyVersionMap = {
  "@elysiajs/node": "^1.4.5",
  "@types/node": "^25.6.2",
  dotenv: "^17.4.2",
  "mongodb-memory-server": "^11.1.0",
  tsx: "^4.21.0",
} as const;

export const PRISMA_NEXT_DEFAULT_VERSION = "latest";
const PKG_PR_NEW_PREFIX = "pkg-pr-new:";
const PKG_PR_NEW_BASE_URL = "https://pkg.pr.new/prisma/prisma-next";

export type ResolvedPrismaNextSpec =
  | { kind: "npm"; spec: string }
  | { kind: "pkg-pr-new"; ref: string };

export const DEFAULT_PRISMA_NEXT_SPEC: ResolvedPrismaNextSpec = {
  kind: "npm",
  spec: PRISMA_NEXT_DEFAULT_VERSION,
};

export function parsePrismaNextVersionSpec(input: string | undefined): ResolvedPrismaNextSpec {
  if (input === undefined) {
    return DEFAULT_PRISMA_NEXT_SPEC;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return DEFAULT_PRISMA_NEXT_SPEC;
  }

  if (trimmed.startsWith(PKG_PR_NEW_PREFIX)) {
    const ref = trimmed.slice(PKG_PR_NEW_PREFIX.length).trim();
    if (ref.length === 0) {
      throw new Error(
        `Invalid --prisma-next-version value: '${input}'. Expected 'pkg-pr-new:<sha|branch|pr-number>'.`,
      );
    }

    return { kind: "pkg-pr-new", ref };
  }

  return { kind: "npm", spec: trimmed };
}

export type AvailableDependency = keyof typeof dependencyVersionMap;

export type CreateTemplateDependencyTarget = {
  packageJsonPath: string;
  dependencies: string[];
  devDependencies: string[];
  customDependencies?: Record<string, string>;
};

export function isPrismaNextPackage(packageName: string): boolean {
  return packageName === "prisma-next" || packageName.startsWith("@prisma-next/");
}

export function getPrismaNextPackageSpecifier(
  packageName: string,
  spec: ResolvedPrismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
): string {
  if (spec.kind === "pkg-pr-new") {
    return `${PKG_PR_NEW_BASE_URL}/${packageName}@${spec.ref}`;
  }

  return `${packageName}@${spec.spec}`;
}

export function getDependencyVersion(
  packageName: string,
  prismaNextSpec: ResolvedPrismaNextSpec = DEFAULT_PRISMA_NEXT_SPEC,
): string | undefined {
  if (isPrismaNextPackage(packageName)) {
    if (prismaNextSpec.kind === "pkg-pr-new") {
      return `${PKG_PR_NEW_BASE_URL}/${packageName}@${prismaNextSpec.ref}`;
    }

    return prismaNextSpec.spec;
  }

  return dependencyVersionMap[packageName as AvailableDependency];
}

function usesViteDevServer(template: CreateTemplate): boolean {
  return (
    template === "astro" ||
    template === "nuxt" ||
    template === "svelte" ||
    template === "tanstack-start"
  );
}

export function getCreateTemplateDependencies(
  template: CreateTemplate,
  packageManager: PackageManager,
): CreateTemplateDependencyTarget[] {
  const targets: CreateTemplateDependencyTarget[] = [];

  if (usesViteDevServer(template)) {
    targets.push({
      packageJsonPath: "package.json",
      dependencies: [],
      devDependencies: ["@prisma-next/vite-plugin-contract-emit"],
    });
  }

  if (
    template === "minimal" ||
    template === "hono" ||
    template === "elysia" ||
    template === "nest"
  ) {
    const runtimeDevDependencies: string[] = usesNodeStyleRuntime(packageManager) ? ["tsx"] : [];

    if (template === "elysia" && packageManager !== "deno") {
      targets.push({
        packageJsonPath: "package.json",
        dependencies: ["@elysiajs/node"],
        devDependencies: ["@types/node", ...runtimeDevDependencies],
      });
    } else if (runtimeDevDependencies.length > 0) {
      targets.push({
        packageJsonPath: "package.json",
        dependencies: [],
        devDependencies: runtimeDevDependencies,
      });
    }
  }

  return targets;
}
