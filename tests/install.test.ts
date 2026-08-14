import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dependencyVersionMap, PRISMA_PLATFORM_CLI_PACKAGE } from "../src/constants/dependencies";
import { scaffoldCreateTemplate } from "../src/templates/render-create-template";
import {
  getComposerScriptMap,
  writeCreateTemplateDependencies,
  writePrismaDependencies,
} from "../src/tasks/install";
import { authoringStyles, createTemplates, databaseProviders, packageManagers } from "../src/types";
import { getInstallArgs } from "../src/utils/package-manager";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

async function withPackageJson<T>(run: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-install-"));
  try {
    await writeFile(path.join(projectDir, "package.json"), '{"name":"app"}\n');
    return await run(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function readPackageJson(projectDir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8")) as PackageJson;
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("writePrismaDependencies", () => {
  test("writes the Prisma Next Postgres runtime and Composer-ready scripts", async () => {
    await withPackageJson(async (projectDir) => {
      await writePrismaDependencies("postgres", "pnpm", "psl", projectDir);
      const packageJson = await readPackageJson(projectDir);

      expect(packageJson.dependencies).toMatchObject({
        "@prisma/orm-postgres": dependencyVersionMap["@prisma/orm-postgres"],
        dotenv: dependencyVersionMap.dotenv,
      });
      expect(packageJson.devDependencies).toMatchObject({
        "prisma-next": dependencyVersionMap["prisma-next"],
      });
      expect(packageJson.scripts).toMatchObject({
        "contract:emit": "prisma-next contract emit",
        "db:seed": "tsx src/prisma/seed.ts",
      });
    });
  });

  test("adds the MongoDB runtime and direct peer dependencies", async () => {
    await withPackageJson(async (projectDir) => {
      await writePrismaDependencies("mongo", "bun", "typescript", projectDir);
      const packageJson = await readPackageJson(projectDir);
      expect(packageJson.dependencies).toMatchObject({
        "@prisma/orm-mongo": dependencyVersionMap["@prisma/orm-mongo"],
        arktype: dependencyVersionMap.arktype,
        mongodb: dependencyVersionMap.mongodb,
      });
      expect(packageJson.dependencies?.["@prisma/orm-postgres"]).toBeUndefined();
      expect(packageJson.scripts?.["db:seed"]).toBe("bun src/prisma/seed.ts");
    });
  });
});

describe("Composer package-manager commands", () => {
  test("uses each selected package manager for Prisma CLI execution", () => {
    expect(getComposerScriptMap("npm")["composer:deploy"]).toBe(
      `npx --yes ${PRISMA_PLATFORM_CLI_PACKAGE} composer deploy module.ts`,
    );
    expect(getComposerScriptMap("pnpm")["composer:deploy"]).toBe(
      `pnpm dlx ${PRISMA_PLATFORM_CLI_PACKAGE} composer deploy module.ts`,
    );
    expect(getComposerScriptMap("yarn")["composer:deploy"]).toBe(
      `yarn dlx ${PRISMA_PLATFORM_CLI_PACKAGE} composer deploy module.ts`,
    );
    expect(getComposerScriptMap("bun")["composer:deploy"]).toBe(
      `bunx ${PRISMA_PLATFORM_CLI_PACKAGE} composer deploy module.ts`,
    );
  });

  test("keeps installs package-manager native", () => {
    for (const packageManager of packageManagers) {
      expect(getInstallArgs(packageManager)).toEqual({
        command: packageManager,
        args: ["install"],
      });
    }
  });
});

describe("generated templates", () => {
  test("renders Composer into every supported combination", async () => {
    for (const template of createTemplates) {
      for (const provider of databaseProviders) {
        for (const authoring of authoringStyles) {
          for (const packageManager of packageManagers) {
            const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-matrix-"));
            try {
              await scaffoldCreateTemplate({
                projectDir,
                projectName: "matrix-app",
                template,
                provider,
                authoring,
                packageManager,
              });
              await writeCreateTemplateDependencies({ template, packageManager, projectDir });

              const packageJson = await readPackageJson(projectDir);
              const moduleSource = await readFile(path.join(projectDir, "module.ts"), "utf8");
              const serviceSource = await readFile(path.join(projectDir, "service.ts"), "utf8");
              const dbSource = await readFile(path.join(projectDir, "src/prisma/db.ts"), "utf8");
              const prismaConfig = await readFile(
                path.join(projectDir, "prisma.config.ts"),
                "utf8",
              );

              expect(packageJson.scripts?.deploy).toBeDefined();
              expect(packageJson.dependencies).toHaveProperty("@prisma/composer");
              expect(prismaConfig).toContain('configPath: "./prisma-composer.config.ts"');
              expect(serviceSource).toContain("compute({");
              if (template === "elysia") {
                const serverSource = await readFile(path.join(projectDir, "src/index.ts"), "utf8");
                expect(serverSource).toContain('.listen({ port, hostname: "0.0.0.0" })');
              }
              if (provider === "postgres") {
                expect(moduleSource).toContain("pnPostgres({");
                const composerSource = await readFile(
                  path.join(projectDir, "src/prisma/composer.ts"),
                  "utf8",
                );
                if (authoring === "typescript") {
                  expect(composerSource).toContain(
                    'import type { Contract } from "./generated/contract.d.ts";',
                  );
                  expect(composerSource).toContain(
                    'import contractJson from "./generated/contract.json"',
                  );
                } else {
                  expect(composerSource).toContain(
                    'import type { Contract } from "./contract.d.ts";',
                  );
                  expect(composerSource).toContain("pnContract<Contract>(contractJson)");
                }
              } else {
                expect(moduleSource).toContain('envSecret("MONGODB_URL")');
              }
              if (authoring === "typescript") {
                expect(dbSource).toContain(
                  'import type { Contract } from "./generated/contract.d.ts";',
                );
                expect(dbSource).toContain('import contractJson from "./generated/contract.json"');
              } else {
                expect(dbSource).toContain('import type { Contract } from "./contract.d.ts";');
                expect(dbSource).toContain("contractJson,");
              }
              const prismaNextConfig = await readFile(
                path.join(projectDir, "prisma-next.config.ts"),
                "utf8",
              );
              if (authoring === "typescript") {
                expect(prismaNextConfig).toContain('output: "./src/prisma/generated"');
              } else {
                expect(prismaNextConfig).not.toContain("output:");
              }
              expect(await pathExists(path.join(projectDir, "deno.json"))).toBe(false);
              if (packageManager === "pnpm") {
                expect(packageJson.pnpm).toBeUndefined();
                expect(await readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8")).toBe(
                  [
                    "allowBuilds:",
                    "  esbuild: true",
                    "  msgpackr-extract: true",
                    "  workerd: true",
                    "minimumReleaseAgeExclude:",
                    '  - "@prisma/*"',
                    '  - "prisma-next"',
                    "overrides:",
                    '  effect: "4.0.0-beta.103"',
                    "",
                  ].join("\n"),
                );
              } else if (packageManager === "yarn") {
                expect(packageJson.resolutions?.effect).toBe("4.0.0-beta.103");
              } else {
                expect(packageJson.overrides?.effect).toBe("4.0.0-beta.103");
              }
            } finally {
              await rm(projectDir, { recursive: true, force: true });
            }
          }
        }
      }
    }
  });
});
