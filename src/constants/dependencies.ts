import type { CreateTemplate, PackageManager } from "../types";
import { usesNodeStyleRuntime } from "../utils/runtime";

export const dependencyVersionMap = {
  "@elysiajs/node": "^1.4.5",
  "@libsql/client": "^0.17.4",
  "@prisma/client": "^7.8.0",
  "@prisma/adapter-pg": "^7.8.0",
  "@prisma/adapter-libsql": "^7.8.0",
  "@prisma/adapter-mariadb": "^7.8.0",
  "@prisma/adapter-mssql": "^7.8.0",
  "@prisma/composer": "0.6.0",
  "@prisma/composer-prisma-cloud": "0.6.0",
  "@types/node": "^26.0.0",
  arktype: "^2.2.3",
  dotenv: "^17.4.2",
  effect: "4.0.0-beta.93",
  esbuild: "^0.28.2",
  prisma: "^7.8.0",
  tsx: "^4.22.4",
} as const;

export type AvailableDependency = keyof typeof dependencyVersionMap;

export type CreateTemplateDependencyTarget = {
  packageJsonPath: string;
  dependencies: AvailableDependency[];
  devDependencies: AvailableDependency[];
  customDependencies?: Record<string, string>;
};

const composerTemplates = new Set<CreateTemplate>([
  "hono",
  "elysia",
  "nest",
  "next",
  "astro",
  "nuxt",
  "tanstack-start",
  "turborepo",
]);

function getWorkspaceDependencyVersion(packageManager: PackageManager): string {
  return packageManager === "npm" ? "*" : "workspace:*";
}

export function getCreateTemplateDependencies(
  template: CreateTemplate,
  packageManager: PackageManager,
  composer = false,
): CreateTemplateDependencyTarget[] {
  const targets: CreateTemplateDependencyTarget[] = [];

  if (template === "hono" || template === "elysia" || template === "nest") {
    const runtimeDevDependencies: AvailableDependency[] = usesNodeStyleRuntime(packageManager)
      ? ["tsx"]
      : [];

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

  if (template === "turborepo") {
    targets.push({
      packageJsonPath: "apps/api/package.json",
      dependencies: ["dotenv"],
      devDependencies: ["tsx"],
      customDependencies: {
        "@repo/db": getWorkspaceDependencyVersion(packageManager),
      },
    });
  }

  if (composer && composerTemplates.has(template)) {
    targets.push({
      packageJsonPath: "package.json",
      dependencies: ["@prisma/composer", "@prisma/composer-prisma-cloud", "arktype", "effect"],
      devDependencies:
        template === "hono" || template === "elysia" || template === "nest" ? ["esbuild"] : [],
    });

    if (template === "turborepo") {
      targets.push({
        packageJsonPath: "apps/api/package.json",
        dependencies: [],
        devDependencies: ["esbuild"],
      });
    }
  }

  return targets;
}
