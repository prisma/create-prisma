import type { CreateTemplate, PackageManager } from "../types";

export const dependencyVersionMap = {
  "@astrojs/node": "^11.1.7",
  "@elysia/node": "^1.4.6",
  "@prisma/composer": "0.28.0",
  "@prisma/composer-prisma-cloud": "0.28.0",
  "@prisma/dev": "0.25.2",
  "@prisma/orm-mongo": "8.0.0-rc.16",
  // Must match @prisma/composer-prisma-cloud's exact peerDependency, even when
  // prisma bundles a newer @prisma/orm-toolchain, or npm install fails with
  // ERESOLVE.
  "@prisma/orm-postgres": "8.0.0-rc.16",
  "@sveltejs/adapter-node": "^6.0.0",
  "@types/node": "^26.6.4",
  alchemy: "2.0.0-beta.78",
  arktype: "^2.2.7",
  dotenv: "^18.0.6",
  effect: "4.0.0-rc.115",
  mongodb: "^7.7.0",
  "mongodb-memory-server": "^11.3.0",
  nitro: "^3.0.260903-beta",
  // Must match the @prisma/composer-cli version this prisma release depends on.
  // `bun run check:pins` verifies that against the Composer pins above.
  prisma: "8.0.0-rc.21",
  // Node 22 needs a global Temporal for the ORM runtime's timestamp columns.
  "temporal-polyfill": "^1.0.5",
  tsdown: "^0.23.0",
  turbo: "2.11.7",
  tsx: "^4.23.15",
  typescript: "^6.0.3",
} as const;

// Pinned to the effect version as a set: @effect/* siblings depend on each other with
// caret prerelease ranges, so a newer rc (e.g. platform-node-shared rc.118) floats in and
// imports effect modules the pinned effect lacks.
export const effectPackages = [
  "effect",
  "@effect/platform-bun",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/sql-d1",
  "@effect/sql-sqlite-do",
  "@effect/vitest",
] as const;

export const PRISMA_PLATFORM_CLI_PACKAGE = `prisma@${dependencyVersionMap.prisma}`;
// Deno runs the same consolidated CLI. The former `prisma-next` fallback is
// frozen and cannot emit against the current ORM releases.
export const PRISMA_DENO_CLI_PACKAGE = PRISMA_PLATFORM_CLI_PACKAGE;

export type AvailableDependency = keyof typeof dependencyVersionMap;

export type CreateTemplateDependencyTarget = {
  packageJsonPath: string;
  dependencies: string[];
  devDependencies: string[];
  customDependencies?: Record<string, string>;
};

export function getDependencyVersion(packageName: string): string | undefined {
  return dependencyVersionMap[packageName as AvailableDependency];
}

function usesTsdown(template: CreateTemplate): boolean {
  return (
    template === "minimal" || template === "hono" || template === "elysia" || template === "nest"
  );
}

export function getCreateTemplateDependencies(
  template: CreateTemplate,
  packageManager: PackageManager,
): CreateTemplateDependencyTarget[] {
  const dependencies = ["@prisma/composer", "@prisma/composer-prisma-cloud", "alchemy"];
  const devDependencies: string[] = [];

  if (usesTsdown(template)) {
    devDependencies.push("tsdown");
    devDependencies.push("tsx");
  }
  if (template === "minimal") {
    devDependencies.push("typescript");
  }
  if (template === "elysia") {
    dependencies.push("@elysia/node");
    devDependencies.push("@types/node");
  }
  if (template === "svelte") {
    devDependencies.push("@sveltejs/adapter-node");
  }
  if (template === "astro") {
    dependencies.push("@astrojs/node");
  }
  if (template === "tanstack-start") {
    devDependencies.push("nitro");
  }
  if (template === "turborepo") devDependencies.push("turbo", "typescript");

  const targets: CreateTemplateDependencyTarget[] = [
    {
      packageJsonPath: "package.json",
      dependencies,
      devDependencies,
    },
  ];
  if (template === "turborepo") {
    targets.push({
      packageJsonPath: "apps/server/package.json",
      dependencies: [],
      devDependencies: ["@types/node", "tsdown", "tsx", "typescript"],
      customDependencies: {
        "@repo/database": packageManager === "npm" ? "*" : "workspace:*",
      },
    });
    targets.push({
      packageJsonPath: "packages/database/package.json",
      dependencies: [],
      devDependencies: ["typescript"],
    });
  }
  return targets;
}
