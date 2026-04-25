import type { CreateTemplate, PackageManager } from "../types";
import { usesNodeStyleRuntime } from "../utils/runtime";

export const dependencyVersionMap = {
  "@elysiajs/node": "^1.4.5",
  "@prisma/client": "^7.8.0",
  "@prisma/adapter-pg": "^7.8.0",
  "@prisma/adapter-libsql": "^7.8.0",
  "@prisma/adapter-mariadb": "^7.8.0",
  "@prisma/adapter-better-sqlite3": "^7.8.0",
  "@prisma/adapter-mssql": "^7.8.0",
  "@types/node": "^24.3.0",
  dotenv: "^17.2.3",
  prisma: "^7.8.0",
  tsx: "^4.21.0",
} as const;

export type AvailableDependency = keyof typeof dependencyVersionMap;

export type CreateTemplateDependencyTarget = {
  packageJsonPath: string;
  dependencies: AvailableDependency[];
  devDependencies: AvailableDependency[];
  customDependencies?: Record<string, string>;
};

function getWorkspaceDependencyVersion(packageManager: PackageManager): string {
  return packageManager === "npm" ? "*" : "workspace:*";
}

export function getCreateTemplateDependencies(
  template: CreateTemplate,
  packageManager: PackageManager,
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
      dependencies: [],
      devDependencies: ["tsx"],
      customDependencies: {
        "@repo/db": getWorkspaceDependencyVersion(packageManager),
      },
    });
  }

  return targets;
}
