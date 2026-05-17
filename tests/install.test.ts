import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dependencyVersionMap } from "../src/constants/dependencies";
import { scaffoldCreateTemplate } from "../src/templates/render-create-template";
import { writeCreateTemplateDependencies, writePrismaDependencies } from "../src/tasks/install";
import { getInstallArgs } from "../src/utils/package-manager";

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

        expect(packageJson.dependencies).toMatchObject({
          "@prisma-next/mongo": dependencyVersionMap["@prisma-next/mongo"],
          dotenv: dependencyVersionMap.dotenv,
          hono: "^4.12.2",
        });
        expect(packageJson.devDependencies).toMatchObject({
          "@prisma-next/agent-skill": dependencyVersionMap["@prisma-next/agent-skill"],
          "@prisma-next/cli": dependencyVersionMap["@prisma-next/cli"],
          "@prisma-next/mongo-contract-ts": dependencyVersionMap["@prisma-next/mongo-contract-ts"],
          "@prisma-next/mongo-orm": dependencyVersionMap["@prisma-next/mongo-orm"],
          "@prisma-next/target-mongo": dependencyVersionMap["@prisma-next/target-mongo"],
          "@types/node": dependencyVersionMap["@types/node"],
          "prisma-next": dependencyVersionMap["prisma-next"],
          skills: dependencyVersionMap.skills,
          typescript: "^5.8.3",
        });
        expect(packageJson.scripts).toMatchObject({
          dev: "bun --watch src/index.ts",
          "contract:emit": "bun prisma-next contract emit",
          "migration:plan": "bun prisma-next migration plan",
          "migration:apply": "bun prisma-next migration apply",
          "skills:sync": 'skills experimental_sync --agent "*" -y',
        });
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
          "contract:emit": `deno run -A --env-file=.env npm:prisma-next@${dependencyVersionMap["prisma-next"]} contract emit`,
          "migration:plan": `deno run -A --env-file=.env npm:prisma-next@${dependencyVersionMap["prisma-next"]} migration plan`,
          "skills:sync": `deno run -A npm:skills@${dependencyVersionMap.skills} experimental_sync --agent "*" -y`,
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
          "@prisma-next/vite-plugin-contract-emit":
            dependencyVersionMap["@prisma-next/vite-plugin-contract-emit"],
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
});

describe("getInstallArgs", () => {
  test("keeps non-Deno installs as plain package-manager install commands", () => {
    expect(getInstallArgs("npm")).toEqual({ command: "npm", args: ["install"] });
    expect(getInstallArgs("pnpm")).toEqual({ command: "pnpm", args: ["install"] });
    expect(getInstallArgs("yarn")).toEqual({ command: "yarn", args: ["install"] });
    expect(getInstallArgs("bun")).toEqual({ command: "bun", args: ["install"] });
  });
});
