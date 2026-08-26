import type { CreateTemplate, PackageManager } from "../types";

export const dependencyVersionMap = {
  "@astrojs/node": "^10.0.2",
  "@elysiajs/node": "^1.4.5",
  "@prisma/composer": "0.16.0",
  "@prisma/composer-prisma-cloud": "0.16.0",
  "@prisma/orm-mongo": "8.0.0-rc.8",
  // Must match @prisma/composer-prisma-cloud's exact peerDependency.
  "@prisma/orm-postgres": "8.0.0-rc.8",
  "@sveltejs/adapter-node": "^5.3.2",
  "@types/node": "^25.6.2",
  alchemy: "2.0.0-beta.74",
  arktype: "^2.2.3",
  dotenv: "^17.4.2",
  esbuild: "^0.28.1",
  effect: "4.0.0-rc.112",
  mongodb: "^7.1.0",
  "mongodb-memory-server": "^11.1.0",
  nitro: "^3.0.260610-beta",
  prisma: "8.0.0-rc.12",
  // The ORM runtime's timestamp columns need a global Temporal, which no
  // stable Node or Bun ships yet.
  "temporal-polyfill": "^1.0.4",
  tsx: "^4.21.0",
  typescript: "^5.9.3",
} as const;

// Pinned, not `prisma@next`: the scaffold's own invocations must not float
// with the dist-tag — the rc line ships breaking changes between releases
// (rc.10 broke every create). The pin must move in lockstep with the pins
// above: the CLI bundles its own copies of @prisma/composer-cli and
// @prisma/orm-toolchain, and those must match the @prisma/composer* and
// @prisma/orm-* versions this map installs into the project.
export const PRISMA_PLATFORM_CLI_PACKAGE = "prisma@8.0.0-rc.12";
// Deno runs the same pinned consolidated CLI. The former `prisma-next`
// fallback is dead: under Deno the bare `npm:prisma-next` specifier resolves
// to the highest non-prerelease version (0.12.0, frozen), which cannot emit
// against the ORM releases pinned above.
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

function usesEsbuild(template: CreateTemplate): boolean {
  return (
    template === "minimal" || template === "hono" || template === "elysia" || template === "nest"
  );
}

export function getCreateTemplateDependencies(
  template: CreateTemplate,
  _packageManager: PackageManager,
): CreateTemplateDependencyTarget[] {
  const dependencies = ["@prisma/composer", "@prisma/composer-prisma-cloud", "alchemy"];
  const devDependencies: string[] = [];

  if (usesEsbuild(template)) {
    devDependencies.push("esbuild");
  }
  if (template === "minimal" || usesEsbuild(template)) {
    devDependencies.push("tsx");
  }
  if (template === "minimal") {
    devDependencies.push("typescript");
  }
  if (template === "elysia") {
    dependencies.push("@elysiajs/node");
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

  return [
    {
      packageJsonPath: "package.json",
      dependencies,
      devDependencies,
    },
  ];
}
