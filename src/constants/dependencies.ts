import type { CreateTemplate, PackageManager } from "../types";

export const dependencyVersionMap = {
  "@astrojs/node": "^11.1.9",
  "@elysia/node": "^1.4.6",
  "@prisma/composer": "0.40.0",
  "@prisma/composer-prisma-cloud": "0.40.0",
  // Yarn apps list it as a dev dependency, because Yarn does not install peer
  // dependencies. Must match the version the prisma CLI depends on;
  // `bun run check:pins` verifies that.
  "@prisma/cli-engine": "0.10.4",
  "@prisma/dev": "0.25.2",
  "@prisma/management-api-sdk": "^1.101.0",
  "@prisma/orm-mongo": "8.0.0-rc.25",
  // Must match both @prisma/composer-prisma-cloud's exact peerDependency (or npm
  // install fails with ERESOLVE) and the @prisma/orm-toolchain the prisma CLI
  // bundles (or `prisma contract emit` rejects the ORM packages).
  // `bun run check:pins` verifies both.
  "@prisma/orm-postgres": "8.0.0-rc.25",
  "@sveltejs/adapter-node": "^6.0.0",
  "@types/node": "^26.6.5",
  "@types/pg": "^8.20.0",
  "@vitejs/devtools": "0.7.6",
  alchemy: "2.0.0-beta.87",
  arktype: "^2.2.9",
  dotenv: "^18.0.9",
  effect: "4.1.4",
  mongodb: "^7.7.0",
  "mongodb-memory-server": "^11.3.0",
  nitro: "^3.0.260903-beta",
  pg: "^8.22.0",
  // Must match the @prisma/composer-cli version this prisma release depends on.
  // `bun run check:pins` verifies that against the Composer pins above.
  prisma: "8.0.0-rc.35",
  // Node 22 needs a global Temporal for the ORM runtime's timestamp columns.
  "temporal-polyfill": "^1.0.8",
  tsdown: "^0.23.1",
  turbo: "2.11.10",
  tsx: "^4.23.15",
  typescript: "^6.0.3",
} as const;

// Pinned to the effect version as a set: @effect/* siblings depend on each other with
// caret ranges, so a newer sibling floats in and imports effect modules the pinned
// effect lacks.
export const effectPackages = [
  "effect",
  "@effect/platform-bun",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/vitest",
] as const;

export const PRISMA_PLATFORM_CLI_PACKAGE = `prisma@${dependencyVersionMap.prisma}`;
// Deno runs the same consolidated CLI. The former `prisma-next` fallback is
// frozen and cannot emit against the current ORM releases.
export const PRISMA_DENO_CLI_PACKAGE = PRISMA_PLATFORM_CLI_PACKAGE;

export type AvailableDependency = keyof typeof dependencyVersionMap;

// Yarn does not install peer dependencies, so a Yarn app lists the required peers
// of each package here in every package.json that lists the package.
// `bun run check:pins` verifies each list and version against npm.
export const yarnPeerDependencies = {
  "@prisma/cli-engine": ["@prisma/management-api-sdk"],
  "@prisma/composer": [],
  "@prisma/composer-prisma-cloud": ["@prisma/orm-postgres", "@types/pg", "pg"],
  "@prisma/dev": [],
  "@prisma/orm-mongo": ["mongodb", "temporal-polyfill"],
  "@prisma/orm-postgres": ["@types/pg", "pg", "temporal-polyfill"],
  // The peers of @prisma/orm-toolchain, which prisma.config.ts loads when the
  // prisma CLI runs it.
  prisma: ["@prisma/cli-engine"],
} as const satisfies Partial<Record<AvailableDependency, readonly AvailableDependency[]>>;

type DependencySections = { dependencies: string[]; devDependencies: string[] };

export function getMissingYarnPeerDependencies(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): DependencySections {
  const peersOf = yarnPeerDependencies as Partial<Record<string, readonly string[]>>;
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  const missing: DependencySections = { dependencies: [], devDependencies: [] };
  const addPeersOf = (packageName: string, section: keyof DependencySections) => {
    for (const peer of peersOf[packageName] ?? []) {
      if (declared.has(peer)) continue;
      declared.add(peer);
      missing[peer.startsWith("@types/") ? "devDependencies" : section].push(peer);
      addPeersOf(peer, section);
    }
  };
  for (const name of Object.keys(manifest.dependencies ?? {})) addPeersOf(name, "dependencies");
  for (const name of Object.keys(manifest.devDependencies ?? {})) {
    addPeersOf(name, "devDependencies");
  }
  return missing;
}

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
