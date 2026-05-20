import type { CreateTemplate, PackageManager } from "../types";
import { usesNodeStyleRuntime } from "../utils/runtime";

export const dependencyVersionMap = {
  "@elysiajs/node": "^1.4.5",
  "@types/node": "^25.6.2",
  dotenv: "^17.4.2",
  skills: "1.5.7",
  tsx: "^4.21.0",
} as const;

export const PRISMA_NEXT_PACKAGE_VERSION = "latest";

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

export function getPrismaNextPackageSpecifier(packageName: string): string {
  return `${packageName}@${PRISMA_NEXT_PACKAGE_VERSION}`;
}

export function getDependencyVersion(packageName: string): string | undefined {
  if (isPrismaNextPackage(packageName)) {
    return PRISMA_NEXT_PACKAGE_VERSION;
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
