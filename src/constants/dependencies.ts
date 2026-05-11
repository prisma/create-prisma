import type { CreateTemplate, PackageManager } from "../types";
import { usesNodeStyleRuntime } from "../utils/runtime";

export const dependencyVersionMap = {
  "@elysiajs/node": "^1.4.5",
  "@prisma-next/adapter-mongo": "0.4.4",
  "@prisma-next/adapter-postgres": "0.4.4",
  "@prisma-next/cli": "0.4.4",
  "@prisma-next/contract": "0.4.4",
  "@prisma-next/family-mongo": "0.4.4",
  "@prisma-next/family-sql": "0.4.4",
  "@prisma-next/mongo": "0.4.4",
  "@prisma-next/mongo-contract": "0.4.4",
  "@prisma-next/mongo-contract-ts": "0.4.4",
  "@prisma-next/postgres": "0.4.4",
  "@prisma-next/sql-contract": "0.4.4",
  "@prisma-next/sql-contract-ts": "0.4.4",
  "@prisma-next/target-mongo": "0.4.4",
  "@prisma-next/target-postgres": "0.4.4",
  "@types/node": "^25.6.2",
  dotenv: "^17.4.2",
  "prisma-next": "0.4.4",
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
