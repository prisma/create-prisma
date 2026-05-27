import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dependencyVersionMap, PRISMA_NEXT_DEFAULT_VERSION } from "../src/constants/dependencies";
import { scaffoldCreateTemplate } from "../src/templates/render-create-template";
import { writeCreateTemplateDependencies, writePrismaDependencies } from "../src/tasks/install";
import { getDenoPrismaSpecifier, getInstallArgs } from "../src/utils/package-manager";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

async function withPackageJson<T>(
  packageJson: Record<string, unknown>,
  run: (projectDir: string) => Promise<T>,
): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-install-"));

  try {
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify(packageJson, null, 2));
    return await run(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function readPackageJson(projectDir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8")) as PackageJson;
}

function expectPrismaNextPackagesUseLatest(packageJson: PackageJson): void {
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (packageName === "prisma-next" || packageName.startsWith("@prisma-next/")) {
      expect(version).toBe(PRISMA_NEXT_DEFAULT_VERSION);
    }
  }
}

describe("writePrismaDependencies", () => {
  test("writes Prisma Next dependencies and scripts before any install command runs", async () => {
    await withPackageJson(
      {
        name: "app",
        scripts: {
          dev: "bun --watch src/index.ts",
        },
        dependencies: {
          hono: "^4.12.2",
        },
        devDependencies: {
          typescript: "^5.8.3",
        },
      },
      async (projectDir) => {
        await writePrismaDependencies("mongo", "bun", "typescript", projectDir);

        const packageJson = await readPackageJson(projectDir);
        expectPrismaNextPackagesUseLatest(packageJson);

        expect(packageJson.dependencies).toMatchObject({
          "@prisma-next/mongo": PRISMA_NEXT_DEFAULT_VERSION,
          dotenv: dependencyVersionMap.dotenv,
          hono: "^4.12.2",
        });
        expect(packageJson.devDependencies).toMatchObject({
          "@prisma-next/cli": PRISMA_NEXT_DEFAULT_VERSION,
          "@prisma-next/mongo-contract-ts": PRISMA_NEXT_DEFAULT_VERSION,
          "@prisma-next/mongo-orm": PRISMA_NEXT_DEFAULT_VERSION,
          "@prisma-next/target-mongo": PRISMA_NEXT_DEFAULT_VERSION,
          "@types/node": dependencyVersionMap["@types/node"],
          "prisma-next": PRISMA_NEXT_DEFAULT_VERSION,
          typescript: "^5.8.3",
        });
        expect(packageJson.scripts).toMatchObject({
          dev: "bun --watch src/index.ts",
          "contract:emit": "bun prisma-next contract emit",
          "migration:plan": "bun prisma-next migration plan",
          migrate: "bun prisma-next migrate",
        });
      },
    );
  });

  test("pins every Prisma Next package to a non-default spec when one is provided", async () => {
    await withPackageJson(
      {
        name: "app",
        dependencies: {},
        devDependencies: {},
      },
      async (projectDir) => {
        await writePrismaDependencies("postgres", "bun", "psl", projectDir, {
          kind: "npm",
          spec: "0.10.0",
        });

        const packageJson = await readPackageJson(projectDir);
        const allDependencies = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };

        for (const [packageName, version] of Object.entries(allDependencies)) {
          if (packageName === "prisma-next" || packageName.startsWith("@prisma-next/")) {
            expect(version).toBe("0.10.0");
          }
        }
      },
    );
  });

  test("writes pkg.pr.new URL specifiers for every Prisma Next dependency", async () => {
    await withPackageJson(
      {
        name: "app",
        dependencies: {},
        devDependencies: {},
      },
      async (projectDir) => {
        await writePrismaDependencies("postgres", "bun", "psl", projectDir, {
          kind: "pkg-pr-new",
          ref: "bad6795",
        });

        const packageJson = await readPackageJson(projectDir);
        const allDependencies = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };

        for (const [packageName, version] of Object.entries(allDependencies)) {
          if (packageName === "prisma-next" || packageName.startsWith("@prisma-next/")) {
            expect(version).toBe(`https://pkg.pr.new/prisma/prisma-next/${packageName}@bad6795`);
          }
        }
      },
    );
  });

  test("normalizes Prisma Next scripts after prisma-next init writes package-manager defaults", async () => {
    await withPackageJson(
      {
        name: "app",
        scripts: {
          "contract:emit": "prisma-next contract emit",
        },
        dependencies: {},
        devDependencies: {},
      },
      async (projectDir) => {
        await writePrismaDependencies("mongo", "deno", "psl", projectDir);

        const packageJson = await readPackageJson(projectDir);

        expect(packageJson.scripts).toMatchObject({
          "contract:emit": "deno run -A --env-file=.env npm:prisma-next contract emit",
          "migration:plan": "deno run -A --env-file=.env npm:prisma-next migration plan",
        });
      },
    );
  });
});

describe("writeCreateTemplateDependencies", () => {
  test("adds Prisma Next Vite auto-emit plugin to Vite-backed templates", async () => {
    await withPackageJson(
      {
        name: "app",
        dependencies: {},
        devDependencies: {
          vite: "^7.3.3",
        },
      },
      async (projectDir) => {
        await writeCreateTemplateDependencies({
          template: "svelte",
          packageManager: "bun",
          projectDir,
        });

        const packageJson = await readPackageJson(projectDir);

        expect(packageJson.devDependencies).toMatchObject({
          "@prisma-next/vite-plugin-contract-emit": PRISMA_NEXT_DEFAULT_VERSION,
          vite: "^7.3.3",
        });
      },
    );
  });

  test("does not add the Vite plugin to non-Vite API templates", async () => {
    await withPackageJson(
      {
        name: "app",
        dependencies: {},
        devDependencies: {},
      },
      async (projectDir) => {
        await writeCreateTemplateDependencies({
          template: "hono",
          packageManager: "bun",
          projectDir,
        });

        const packageJson = await readPackageJson(projectDir);

        expect(packageJson.devDependencies).not.toHaveProperty(
          "@prisma-next/vite-plugin-contract-emit",
        );
      },
    );
  });

  test("adds tsx to Minimal projects for Node-style package managers", async () => {
    await withPackageJson(
      {
        name: "app",
        dependencies: {},
        devDependencies: {},
      },
      async (projectDir) => {
        await writeCreateTemplateDependencies({
          template: "minimal",
          packageManager: "npm",
          projectDir,
        });

        const packageJson = await readPackageJson(projectDir);

        expect(packageJson.devDependencies).toMatchObject({
          tsx: dependencyVersionMap.tsx,
        });
        expect(packageJson.devDependencies).not.toHaveProperty(
          "@prisma-next/vite-plugin-contract-emit",
        );
      },
    );
  });
});

describe("scaffoldCreateTemplate", () => {
  test("loads dotenv in seed scripts for Node package managers", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-template-"));

    try {
      await scaffoldCreateTemplate({
        projectDir,
        projectName: "app",
        template: "hono",
        provider: "postgres",
        authoring: "psl",
        packageManager: "npm",
      });

      const seed = await readFile(path.join(projectDir, "prisma/seed.ts"), "utf8");
      expect(seed).toContain('import "dotenv/config";');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("does not add dotenv imports to Bun or Deno seed scripts", async () => {
    for (const packageManager of ["bun", "deno"] as const) {
      const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-template-"));

      try {
        await scaffoldCreateTemplate({
          projectDir,
          projectName: "app",
          template: "hono",
          provider: "postgres",
          authoring: "psl",
          packageManager,
        });

        const seed = await readFile(path.join(projectDir, "prisma/seed.ts"), "utf8");
        expect(seed).not.toContain('import "dotenv/config";');
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    }
  });

  test("renders Minimal as a script-first template without a build pipeline", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-template-"));

    try {
      await scaffoldCreateTemplate({
        projectDir,
        projectName: "app",
        template: "minimal",
        provider: "mongo",
        authoring: "psl",
        packageManager: "bun",
      });

      const packageJson = await readPackageJson(projectDir);
      const index = await readFile(path.join(projectDir, "src/index.ts"), "utf8");

      expect(packageJson.scripts).toEqual({
        dev: "bun src/index.ts",
      });
      expect(index).toContain("db.orm.users");
      expect(index).toContain('username: "first-user"');
      expect(index).toContain("Prisma Next is ready");
      expect(await readFile(path.join(projectDir, "src/lib/prisma.ts"), "utf8")).toContain(
        "@prisma-next/mongo/runtime",
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("getInstallArgs", () => {
  test("keeps non-Deno installs as plain package-manager install commands", () => {
    expect(getInstallArgs("npm")).toEqual({ command: "npm", args: ["install"] });
    expect(getInstallArgs("pnpm")).toEqual({ command: "pnpm", args: ["install"] });
    expect(getInstallArgs("yarn")).toEqual({ command: "yarn", args: ["install"] });
    expect(getInstallArgs("bun")).toEqual({ command: "bun", args: ["install"] });
  });

  test("uses Deno-compatible npm specifiers for Deno installs", () => {
    expect(PRISMA_NEXT_DEFAULT_VERSION).toBe("latest");
    expect(getDenoPrismaSpecifier()).toBe("npm:prisma-next");
    expect(getInstallArgs("deno")).toEqual({
      command: "deno",
      args: [
        "install",
        "--allow-scripts=npm:prisma-next,npm:@prisma-next/postgres,npm:@prisma-next/mongo,npm:mongodb-memory-server",
      ],
    });
  });
});
