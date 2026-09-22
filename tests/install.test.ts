import { describe, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dependencyVersionMap, PRISMA_DENO_CLI_PACKAGE } from "../src/constants/dependencies";
import { applicationRuntime } from "../src/runtime";
import {
  CommandExecutionError,
  CommandRunner,
  type CommandSpec,
} from "../src/services/command-runner";
import { scaffoldCreateTemplate } from "../src/templates/render-create-template";
import {
  getComposerScriptMap,
  writeCreateTemplateDependencies,
  writePrismaDependencies,
} from "../src/tasks/install";
import {
  authoringStyles,
  createTemplates,
  databaseProviders,
  packageManagers,
  type PackageManager,
} from "../src/types";
import {
  getInstallArgs,
  getLocalPackageBinaryArgs,
  getPackageExecutionArgs,
  getRunScriptCommand,
  verifyPackageManagerEffect,
} from "../src/utils/package-manager";

type PackageJson = {
  name?: string;
  workspaces?: string[];
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
};

const tsdownTemplates: ReadonlySet<string> = new Set(["minimal", "hono", "elysia", "nest"]);

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

function verifyPackageManager(
  manager: PackageManager,
  stdout: string | undefined,
  fileSystem?: Partial<FileSystem.FileSystem>,
) {
  const probes: Array<{ spec: CommandSpec; manifest: PackageJson }> = [];
  const result = applicationRuntime.runPromise(
    verifyPackageManagerEffect(manager).pipe(
      Effect.provideService(CommandRunner, {
        run: () => Effect.die("Unexpected unchecked command"),
        runChecked: (spec) => {
          const manifest = JSON.parse(readFileSync(path.join(spec.cwd, "package.json"), "utf8"));
          probes.push({ spec, manifest });
          return stdout === undefined
            ? Effect.fail(
                new CommandExecutionError({
                  command: spec.command,
                  args: [...spec.args],
                  stdout: "",
                  stderr: "",
                  childProcessFailure: "command_not_found",
                }),
              )
            : Effect.succeed({ exitCode: 0, stdout, stderr: "" });
        },
      }),
      fileSystem ? Effect.provide(FileSystem.layerNoop(fileSystem)) : (effect) => effect,
    ),
  );
  return { result, probes };
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
      });
      expect(packageJson.dependencies?.dotenv).toBeUndefined();
      expect(packageJson.devDependencies).toMatchObject({
        prisma: dependencyVersionMap.prisma,
        "@prisma/dev": dependencyVersionMap["@prisma/dev"],
      });
      expect(packageJson.scripts).toMatchObject({
        "contract:emit": "prisma contract emit",
        migrate: "prisma db migrate",
        "skills:sync": "prisma skills sync || exit 0",
      });
      expect(packageJson.scripts?.["db:seed"]).toBeUndefined();
    });
  });

  test("omits the skills:sync script when no agent skills are wanted", async () => {
    await withPackageJson(async (projectDir) => {
      await writePrismaDependencies("postgres", "pnpm", "psl", projectDir, { skillsSync: false });
      const packageJson = await readPackageJson(projectDir);

      expect(packageJson.scripts?.["skills:sync"]).toBeUndefined();
      expect(packageJson.scripts?.["contract:emit"]).toBe("prisma contract emit");
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
      expect(packageJson.devDependencies?.["@prisma/dev"]).toBeUndefined();
      expect(packageJson.scripts?.["db:seed"]).toBeUndefined();
    });
  });

  test("writes Deno-native Prisma scripts without Composer dependencies", async () => {
    await withPackageJson(async (projectDir) => {
      await writePrismaDependencies("postgres", "deno", "psl", projectDir);
      const packageJson = await readPackageJson(projectDir);

      expect(packageJson.dependencies).toMatchObject({
        "@prisma/orm-postgres": dependencyVersionMap["@prisma/orm-postgres"],
        dotenv: dependencyVersionMap.dotenv,
      });
      expect(packageJson.devDependencies).toMatchObject({
        "@types/node": dependencyVersionMap["@types/node"],
        prisma: dependencyVersionMap.prisma,
      });
      expect(packageJson.devDependencies?.["@prisma/cli-engine"]).toBeUndefined();
      expect(packageJson.devDependencies?.["@prisma/dev"]).toBeUndefined();
      expect(packageJson.scripts).toMatchObject({
        "contract:emit": `deno run -A npm:${PRISMA_DENO_CLI_PACKAGE} contract emit`,
        "db:init": `deno run -A --env-file=.env npm:${PRISMA_DENO_CLI_PACKAGE} db init`,
      });
    });
  });
});

describe("Composer package-manager commands", () => {
  test("checks the selected npm binary against the supported resolver version", async () => {
    const invalidVersions = ["", "11.6.", "11..0", "11.6.1e3", "11.0x6.0", "11.06.0"];
    for (const version of [
      "10.9.7",
      "11.5.1",
      "11.5.2",
      "11.6.0",
      "11.6.1",
      "11.6.2",
      "11.19.0",
      "12.0.2",
      ...invalidVersions,
    ]) {
      const { result } = verifyPackageManager("npm", `${version}\n`);
      if (invalidVersions.includes(version)) {
        await expect(result).rejects.toMatchObject({
          reason: "package_manager_check_failed",
          message: `Could not determine the installed npm version: ${version}`,
        });
      } else if (["10.9.7", "11.5.1", "11.5.2"].includes(version)) {
        await expect(result).rejects.toMatchObject({
          reason: "unsupported_package_manager_version",
          message: expect.stringContaining("npm install --global npm@11"),
        });
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    }
  });

  test("probes the selected package manager once in a generated project manifest", async () => {
    for (const [manager, args, stdout, packageManager] of [
      ["npm", ["--version"], "11.6.0\n", "npm@11.6.0"],
      ["pnpm", ["--version"], "11.0.0-rc.1\n", "pnpm@11.21.0"],
      ["yarn", ["--version"], "4.13.0\n", "yarn@4.13.0"],
      ["bun", ["--version"], "1.4.1\n", "bun@1.4.1"],
      ["deno", ["-V"], "deno 2.9.4\n", undefined],
    ] as const) {
      const { result, probes } = verifyPackageManager(manager, stdout);
      await expect(result).resolves.toBeUndefined();
      expect(probes).toHaveLength(1);
      expect(probes[0]!.spec).toMatchObject({ command: manager, args: [...args] });
      expect(probes[0]!.spec.cwd).not.toBe(process.cwd());
      expect(probes[0]!.manifest.packageManager).toBe(packageManager);
      expect(existsSync(probes[0]!.spec.cwd)).toBe(false);
    }
  });

  test("rejects a missing package manager, Yarn 1, and a probe it cannot prepare", async () => {
    const unwritable = { makeTempDirectoryScoped: () => Effect.succeed("unwritable") };
    for (const [stdout, fileSystem, reason] of [
      [undefined, undefined, "package_manager_not_found"],
      ["1.22.22\n", undefined, "unsupported_package_manager_version"],
      ["4.13.0\n", unwritable, "package_manager_check_failed"],
    ] as const) {
      await expect(verifyPackageManager("yarn", stdout, fileSystem).result).rejects.toMatchObject({
        stage: "validate_input",
        reason,
      });
    }
  });

  test("uses each selected package manager for Prisma CLI execution", () => {
    for (const packageManager of ["npm", "pnpm", "yarn", "bun"] as const) {
      expect(getComposerScriptMap(packageManager)["composer:deploy"]).toBe(
        "prisma deploy module.ts",
      );
      expect(getComposerScriptMap(packageManager)["composer:dev"]).toBe("prisma dev module.ts");
    }
    expect(getComposerScriptMap("bun")["composer:destroy"]).toBeUndefined();
    expect(getComposerScriptMap("deno")).toEqual({});
  });

  test("keeps installs package-manager native", () => {
    for (const packageManager of packageManagers) {
      expect(getInstallArgs(packageManager)).toEqual({
        command: packageManager,
        args: packageManager === "deno" ? ["install", "--minimum-dependency-age=0"] : ["install"],
      });
    }
  });

  test("allows create-prisma to resolve freshly published packages with Deno", () => {
    expect(getPackageExecutionArgs("deno", ["prisma@8.0.0-rc.11", "orm", "init"])).toEqual({
      command: "deno",
      args: ["run", "-A", "--minimum-dependency-age=0", "npm:prisma@8.0.0-rc.11", "orm", "init"],
    });
  });

  test("runs the installed Prisma CLI without registry fallback", () => {
    expect(getLocalPackageBinaryArgs("npm", "prisma", ["contract", "emit"])).toEqual({
      command: "npm",
      args: ["exec", "--offline", "--yes=false", "--", "prisma", "contract", "emit"],
    });
    expect(getLocalPackageBinaryArgs("deno", "prisma", ["contract", "emit"])).toEqual({
      command: "deno",
      args: [
        "run",
        "-A",
        "--frozen",
        `npm:prisma@${dependencyVersionMap.prisma}`,
        "contract",
        "emit",
      ],
    });
  });
});

describe("generated templates", () => {
  test("records the agent skills choice in prisma.config.ts and the Nuxt postinstall", async () => {
    for (const skillAgents of [[], ["claude", "cursor"]] as const) {
      for (const template of ["minimal", "nuxt"] as const) {
        const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-skills-"));
        try {
          await scaffoldCreateTemplate({
            projectDir,
            projectName: "skills-app",
            template,
            provider: "postgres",
            authoring: "psl",
            packageManager: "npm",
            skillAgents,
          });
          const prismaConfig = await readFile(path.join(projectDir, "prisma.config.ts"), "utf8");
          const packageJson = await readPackageJson(projectDir);

          expect(prismaConfig).toContain(
            `agents: [${skillAgents.map((agent) => `"${agent}"`).join(", ")}],`,
          );
          if (template === "nuxt") {
            expect(packageJson.scripts?.postinstall).toBe(
              skillAgents.length === 0 ? "nuxt prepare" : "nuxt prepare && npm run skills:sync",
            );
          }
        } finally {
          await rm(projectDir, { recursive: true, force: true });
        }
      }
    }
  });

  test("renders Composer into every supported combination", async () => {
    for (const template of createTemplates) {
      for (const provider of databaseProviders) {
        for (const authoring of authoringStyles) {
          for (const packageManager of packageManagers) {
            if (packageManager === "deno" && (template !== "minimal" || provider !== "postgres")) {
              continue;
            }

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
              await writePrismaDependencies(provider, packageManager, authoring, projectDir, {
                template,
              });

              const packageJson = await readPackageJson(projectDir);
              expect(packageJson.devDependencies?.["@prisma/dev"]).toBe(
                provider === "postgres" && packageManager !== "deno"
                  ? dependencyVersionMap["@prisma/dev"]
                  : undefined,
              );
              expect(packageJson.dependencies?.["@prisma/dev"]).toBeUndefined();
              if (packageManager === "bun") {
                expect(packageJson.packageManager).toBe("bun@1.4.1");
              }
              const prismaSourceRelative =
                template === "turborepo" ? "packages/database/src" : "src/prisma";
              const dbSource = await readFile(
                path.join(projectDir, prismaSourceRelative, "db.ts"),
                "utf8",
              );
              const seedSource = await readFile(
                path.join(projectDir, prismaSourceRelative, "seed.ts"),
                "utf8",
              );
              const usersSource = await readFile(
                path.join(projectDir, prismaSourceRelative, "users.ts"),
                "utf8",
              );
              const tsconfig = await readFile(path.join(projectDir, "tsconfig.json"), "utf8");

              if (packageManager === "deno") {
                expect(await pathExists(path.join(projectDir, "deno.json"))).toBe(true);
                expect(await pathExists(path.join(projectDir, "module.ts"))).toBe(false);
                expect(await pathExists(path.join(projectDir, "service.ts"))).toBe(false);
                expect(await pathExists(path.join(projectDir, "prisma.config.ts"))).toBe(true);
                expect(await pathExists(path.join(projectDir, "prisma-composer.config.ts"))).toBe(
                  false,
                );
                expect(packageJson.dependencies?.["@prisma/composer"]).toBeUndefined();
                expect(packageJson.scripts).toMatchObject({
                  build: "deno check src/index.ts",
                  dev: "deno run -A --env-file=.env --watch src/index.ts",
                  start: "deno run -A --env-file=.env src/index.ts",
                });
                expect(packageJson.scripts?.deploy).toBeUndefined();
                expect(dbSource).toContain('Deno.env.get("DATABASE_URL")');
                expect(dbSource).not.toContain('import service from "../../service.ts"');
                expect(seedSource).toContain("await connectDatabase()");
                expect(usersSource).toContain("await seed()");
                continue;
              }

              const moduleSource = await readFile(path.join(projectDir, "module.ts"), "utf8");
              const serviceSource = await readFile(path.join(projectDir, "service.ts"), "utf8");
              const prismaConfig = await readFile(
                path.join(projectDir, "prisma.config.ts"),
                "utf8",
              );

              expect(packageJson.scripts?.deploy).toBeDefined();
              expect(packageJson.dependencies).toHaveProperty("@prisma/composer");
              expect(packageJson.dependencies).toHaveProperty("alchemy");
              expect(prismaConfig).toContain("orm: ormConfig({");
              expect(prismaConfig).toContain('import { definePrismaConfig } from "prisma/config"');
              expect(prismaConfig).toContain('agents: ["claude", "cursor", "agents", "devin"]');
              expect(prismaConfig).toContain('configPath: "./prisma-composer.config.ts"');
              expect(
                await readFile(path.join(projectDir, "prisma-composer.config.ts"), "utf8"),
              ).toContain('prismaCloud({ region: "us-east-1" })');
              expect(tsconfig).toContain('"node"');
              expect(serviceSource).toContain("compute({");
              expect(dbSource).toContain("export function connectDatabase()");
              expect(seedSource).toContain("await connectDatabase()");
              expect(seedSource).toContain("export function seed()");
              expect(usersSource).toContain("await seed()");
              expect(
                await pathExists(path.join(projectDir, prismaSourceRelative, "starter-data.ts")),
              ).toBe(false);
              if (template === "turborepo") {
                const server = await readPackageJson(path.join(projectDir, "apps/server"));
                const database = await readPackageJson(path.join(projectDir, "packages/database"));
                expect(server.devDependencies?.["@prisma/dev"]).toBeUndefined();
                expect(database.devDependencies?.["@prisma/dev"]).toBeUndefined();
                const root = await readPackageJson(projectDir);
                expect(packageJson.workspaces).toEqual(["apps/*", "packages/*"]);
                expect(packageJson.devDependencies?.turbo).toBe(dependencyVersionMap.turbo);
                expect(server.name).toBe("@repo/server");
                expect(server.dependencies?.["@repo/database"]).toBe(
                  packageManager === "npm" ? "*" : "workspace:*",
                );
                expect(database.name).toBe("@repo/database");
                expect(database.dependencies).toHaveProperty(
                  provider === "postgres" ? "@prisma/orm-postgres" : "@prisma/orm-mongo",
                );
                expect(database.dependencies?.["temporal-polyfill"]).toBe(
                  provider === "postgres" ? dependencyVersionMap["temporal-polyfill"] : undefined,
                );
                for (const name of ["arktype", "mongodb"] as const) {
                  expect(database.dependencies?.[name]).toBe(
                    provider === "mongo" ? dependencyVersionMap[name] : undefined,
                  );
                  expect(root.dependencies?.[name]).toBe(
                    provider === "mongo" && name === "arktype"
                      ? dependencyVersionMap.arktype
                      : undefined,
                  );
                }
                expect(root.dependencies?.["temporal-polyfill"]).toBeUndefined();
                expect(root.dependencies).toHaveProperty(
                  provider === "postgres" ? "@prisma/orm-postgres" : "@prisma/orm-mongo",
                );
                expect(database.scripts).toEqual({
                  typecheck: "tsc --noEmit --project tsconfig.json",
                });
                expect(serviceSource).toContain('entry: "./apps/server/dist/server.mjs"');
                expect(serviceSource).not.toContain("nextjs");
                expect(server.scripts?.build).toBe("tsdown");
                expect(server.devDependencies?.tsdown).toBe(dependencyVersionMap.tsdown);
                expect(await pathExists(path.join(projectDir, "apps/web"))).toBe(false);
                for (const manifest of [root, server, database]) {
                  expect(manifest.dependencies?.next).toBeUndefined();
                  expect(manifest.dependencies?.react).toBeUndefined();
                }
                expect(
                  await readFile(path.join(projectDir, "apps/server/tsdown.config.ts"), "utf8"),
                ).toContain('entry: { server: "src/index.ts" }');
                expect(
                  await readFile(path.join(projectDir, "apps/server/src/index.ts"), "utf8"),
                ).toContain('response.end("Hello World!")');
                expect(dbSource).toContain('import service from "../../../service.ts"');
                expect(await pathExists(path.join(projectDir, "src/prisma"))).toBe(false);
              }
              if (tsdownTemplates.has(template)) {
                expect(packageJson.engines?.node).toBe("^22.18.0 || >=24.11.0");
                expect(packageJson.scripts?.build).toBe("tsdown");
                expect(packageJson.devDependencies).toHaveProperty("tsdown");
                expect(packageJson.devDependencies).not.toHaveProperty("esbuild");
                const buildSource = await readFile(
                  path.join(projectDir, "tsdown.config.ts"),
                  "utf8",
                );
                expect(buildSource).toContain("defineConfig({");
                expect(buildSource).toContain(
                  `entry: { server: "${template === "nest" ? "src/main.ts" : "src/index.ts"}" }`,
                );
                expect(buildSource).toContain("alwaysBundle: (id)");
                expect(buildSource).toContain("onlyBundle: false");
                expect(buildSource).toContain("codeSplitting: false");
                if (template === "nest") {
                  expect(buildSource).toContain("neverBundle: optionalNestDependencies");
                } else {
                  expect(buildSource).not.toContain("optionalNestDependencies");
                }
              } else {
                expect(await pathExists(path.join(projectDir, "tsdown.config.ts"))).toBe(false);
              }
              if (template === "elysia") {
                const serverSource = await readFile(path.join(projectDir, "src/index.ts"), "utf8");
                expect(serverSource).toContain('adapter: "Bun" in globalThis ? undefined : node()');
                expect(serverSource).toContain('.listen({ port, hostname: "0.0.0.0" })');
              }
              if (template === "nest") {
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
              if (template === "nuxt") {
                expect(packageJson.scripts?.postinstall).toBe(
                  `nuxt prepare && ${getRunScriptCommand(packageManager, "skills:sync")}`,
                );
              }
              if (provider === "postgres") {
                expect(moduleSource).toContain("postgres({");
                expect(moduleSource).toContain('config: "./prisma.config.ts"');
                expect(prismaConfig).toContain("connection: process.env.DATABASE_URL!");
                expect(seedSource).toContain("conflictOn: { email: user.email }");
                const composerSource = await readFile(
                  path.join(projectDir, prismaSourceRelative, "composer.ts"),
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
                  expect(composerSource).toContain("dataContract<Contract>(contractJson)");
                }
              } else {
                expect(moduleSource).toContain('envSecret("MONGODB_URL")');
                expect(prismaConfig).toContain("connection: process.env.MONGODB_URL!");
                expect(seedSource).not.toContain(".prisma-composer");
              }
              if (authoring === "typescript") {
                expect(prismaConfig).toContain(`output: "./${prismaSourceRelative}/generated"`);
                expect(dbSource).toContain(
                  'import type { Contract } from "./generated/contract.d.ts";',
                );
                expect(dbSource).toContain('import contractJson from "./generated/contract.json"');
              } else {
                expect(prismaConfig).not.toContain("output:");
                expect(dbSource).toContain('import type { Contract } from "./contract.d.ts";');
                expect(dbSource).toContain("contractJson,");
              }
              expect(await pathExists(path.join(projectDir, "prisma-next.config.ts"))).toBe(false);
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
                    ...(template === "turborepo"
                      ? ["packages:", '  - "apps/*"', '  - "packages/*"']
                      : []),
                    "allowBuilds:",
                    "  esbuild: true",
                    "  msgpackr-extract: true",
                    ...frameworkBuildAllowances,
                    "  workerd: true",
                    "minimumReleaseAgeExclude:",
                    '  - "@prisma/*"',
                    "overrides:",
                    `  effect: "${dependencyVersionMap.effect}"`,
                    "",
                  ].join("\n"),
                );
              } else if (packageManager === "yarn") {
                expect(packageJson.resolutions?.effect).toBe(dependencyVersionMap.effect);
              } else {
                expect(packageJson.overrides?.effect).toBe(dependencyVersionMap.effect);
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
