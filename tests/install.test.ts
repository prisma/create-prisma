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
  test("writes the Prisma 8 Postgres runtime and Composer-ready scripts", async () => {
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
              const seedSource = await readFile(
                path.join(projectDir, "src/prisma/seed.ts"),
                "utf8",
              );
              const starterDataSource = await readFile(
                path.join(projectDir, "src/prisma/starter-data.ts"),
                "utf8",
              );
              const usersSource = await readFile(
                path.join(projectDir, "src/prisma/users.ts"),
                "utf8",
              );
              const prismaConfig = await readFile(
                path.join(projectDir, "prisma.config.ts"),
                "utf8",
              );

              expect(packageJson.scripts?.deploy).toBeDefined();
              expect(packageJson.dependencies).toHaveProperty("@prisma/composer");
              expect(packageJson.dependencies).toHaveProperty("alchemy");
              expect(prismaConfig).toContain('configPath: "./prisma-composer.config.ts"');
              expect(serviceSource).toContain("compute({");
              expect(dbSource).toContain("export function connectDatabase()");
              expect(starterDataSource).toContain("await connectDatabase()");
              expect(usersSource).toContain("await seedStarterData()");
              if (template === "elysia") {
                const serverSource = await readFile(path.join(projectDir, "src/index.ts"), "utf8");
                expect(serverSource).toContain('adapter: "Bun" in globalThis ? undefined : node()');
                expect(serverSource).toContain('.listen({ port, hostname: "0.0.0.0" })');
              }
              if (template === "nest") {
                expect(packageJson.scripts?.build).toContain("--external:'@nestjs/websockets/*'");
                const usersServiceSource = await readFile(
                  path.join(projectDir, "src/users.service.ts"),
                  "utf8",
                );
                const usersControllerSource = await readFile(
                  path.join(projectDir, "src/users.controller.ts"),
                  "utf8",
                );
                expect(usersServiceSource).toContain("@Inject(PrismaService)");
                expect(usersControllerSource).toContain("@Inject(UsersService)");
              }
              if (template === "svelte") {
                const viteConfig = await readFile(path.join(projectDir, "vite.config.ts"), "utf8");
                expect(viteConfig).toContain("noExternal: true");
              }
              if (provider === "postgres") {
                expect(moduleSource).toContain("pnPostgres({");
                expect(seedSource).toContain("COMPOSER_APP_DATABASE_URL");
                expect(starterDataSource).toContain("conflictOn: { email: user.email }");
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
                expect(seedSource).not.toContain("COMPOSER_APP_DATABASE_URL");
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
                const frameworkBuildAllowances =
                  template === "next"
                    ? ["  sharp: true", "  unrs-resolver: true"]
                    : template === "astro"
                      ? ["  sharp: true"]
                      : [];
                expect(await readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8")).toBe(
                  [
                    "allowBuilds:",
                    "  esbuild: true",
                    "  msgpackr-extract: true",
                    ...frameworkBuildAllowances,
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
