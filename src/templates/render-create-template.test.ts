import { afterAll, describe, expect, test } from "bun:test";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

import {
  createTemplates,
  packageManagers,
  type CreateTemplate,
  type PackageManager,
} from "../types";
import { getComposerDeployScriptMap, parsePrismaCliEnvelope } from "../tasks/deploy-with-composer";
import { writeCreateTemplateDependencies, writePrismaDependencies } from "../tasks/install";
import { scaffoldCreateTemplate } from "./render-create-template";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "create-prisma-templates-"));

const uiTemplateFiles: Partial<Record<CreateTemplate, { page: string; stylesheet: string }>> = {
  astro: { page: "src/pages/index.astro", stylesheet: "src/styles.css" },
  next: { page: "src/app/page.tsx", stylesheet: "src/app/globals.css" },
  nuxt: { page: "app/pages/index.vue", stylesheet: "app/assets/css/main.css" },
  svelte: { page: "src/routes/+page.svelte", stylesheet: "src/app.css" },
  "tanstack-start": { page: "src/routes/index.tsx", stylesheet: "src/styles.css" },
};

const apiTemplateEntrypoints: Partial<Record<CreateTemplate, string>> = {
  elysia: "src/index.ts",
  hono: "src/index.ts",
  nest: "src/app.controller.ts",
  turborepo: "apps/api/src/index.ts",
};

const platformDeployCommands: Record<PackageManager, string> = {
  npm: "npx --yes @prisma/cli@next composer deploy module.ts",
  pnpm: "pnpm --silent dlx @prisma/cli@next composer deploy module.ts",
  yarn: "yarn dlx --quiet @prisma/cli@next composer deploy module.ts",
  bun: "bunx --silent @prisma/cli@next composer deploy module.ts",
};

const platformAuthLoginCommands: Record<PackageManager, string> = {
  npm: "npx --yes @prisma/cli@next auth login",
  pnpm: "pnpm --silent dlx @prisma/cli@next auth login",
  yarn: "yarn dlx --quiet @prisma/cli@next auth login",
  bun: "bunx --silent @prisma/cli@next auth login",
};

afterAll(async () => {
  await fs.remove(testRoot);
});

function projectDirFor(
  template: CreateTemplate,
  packageManager: PackageManager,
  composerPostgres: boolean,
): string {
  return path.join(
    testRoot,
    `${template}-${packageManager}-${composerPostgres ? "pg" : "external"}`,
  );
}

describe("Composer-ready create templates", () => {
  for (const template of createTemplates) {
    for (const packageManager of packageManagers) {
      for (const composerPostgres of [true, false]) {
        test(`${template} + ${packageManager} + ${composerPostgres ? "Prisma Postgres" : "external database"}`, async () => {
          const projectDir = projectDirFor(template, packageManager, composerPostgres);
          await scaffoldCreateTemplate({
            projectDir,
            projectName: "matrix-app",
            template,
            provider: composerPostgres ? "postgresql" : "mysql",
            packageManager,
            composerPostgres,
          });
          await writeCreateTemplateDependencies({
            template,
            packageManager,
            projectDir,
          });
          await writePrismaDependencies(
            composerPostgres ? "postgresql" : "mysql",
            packageManager,
            template === "turborepo" ? path.join(projectDir, "packages/db") : projectDir,
          );

          const packageJson = await fs.readJson(path.join(projectDir, "package.json"));
          const moduleSource = await fs.readFile(path.join(projectDir, "module.ts"), "utf8");
          const readmeSource = await fs.readFile(path.join(projectDir, "README.md"), "utf8");
          const databaseSetupPath = path.join(projectDir, "scripts/setup-composer-postgres.mjs");

          expect(packageJson.packageManager).toStartWith(`${packageManager}@`);
          expect(packageJson.dependencies.dotenv).toBe("^17.4.2");
          expect(
            await fs.pathExists(path.join(projectDir, "prisma-composer.config.ts")),
          ).toBeTrue();
          expect(await fs.pathExists(path.join(projectDir, "prisma.compute.ts"))).toBeFalse();
          expect(await fs.pathExists(path.join(projectDir, "deno.json"))).toBeFalse();
          expect(readmeSource).toContain(platformAuthLoginCommands[packageManager]);

          const uiTemplate = uiTemplateFiles[template];
          if (uiTemplate) {
            const pageSource = await fs.readFile(path.join(projectDir, uiTemplate.page), "utf8");
            const stylesheet = await fs.readFile(
              path.join(projectDir, uiTemplate.stylesheet),
              "utf8",
            );
            expect(pageSource).toContain("Start building with Prisma.");
            expect(pageSource).toContain("user-panel");
            expect(stylesheet).toContain("--background: #f7f7f5");
            expect(stylesheet).toContain(".user-row");
          }

          const apiEntrypoint = apiTemplateEntrypoints[template];
          if (apiEntrypoint) {
            const entrypointSource = await fs.readFile(
              path.join(projectDir, apiEntrypoint),
              "utf8",
            );
            expect(entrypointSource).toContain('name: "matrix-app"');
            expect(entrypointSource).toContain('status: "ready"');
            expect(entrypointSource).toContain('users: "/users"');
          }

          if (composerPostgres) {
            expect(moduleSource).toContain("provision(postgres(");
            expect(moduleSource).not.toContain("envSecret(");
            expect(await fs.pathExists(databaseSetupPath)).toBeTrue();
            const setupSource = await fs.readFile(databaseSetupPath, "utf8");
            expect(setupSource).toContain('runPrisma(["migrate", "deploy"], databaseUrl)');
            expect(setupSource).not.toContain('runPrisma(["migrate", "dev"]');
            expect(setupSource).not.toContain("./node_modules/.bin/prisma");
            expect(setupSource).toContain('shell: process.platform === "win32"');
            expect(setupSource).toContain(
              "Prisma CLI returned output that is not a valid result envelope.",
            );
            expect(setupSource).toContain(
              'runPlatformCli(["postgres", "list", "--project", "matrix-app"])',
            );
            expect(setupSource).toContain('"postgres",\n  "connection",\n  "create"');
            expect(setupSource).toContain('"postgres",\n        "connection",\n        "remove"');
            expect(setupSource).not.toContain('"database",\n  "connection"');
            expect(setupSource.indexOf("try {\n  if (!databaseUrl)")).toBeGreaterThan(
              setupSource.indexOf("const connectionId = findConnectionId(connection)"),
            );
          } else {
            expect(moduleSource).toContain('envSecret("PRISMA_APP_DATABASE_URL")');
            expect(moduleSource).not.toContain("provision(postgres(");
            expect(await fs.pathExists(databaseSetupPath)).toBeFalse();
          }
        });
      }
    }
  }
});

describe("Composer deploy scripts", () => {
  for (const packageManager of packageManagers) {
    test(`${packageManager} runs the complete Prisma Postgres deployment`, () => {
      const scripts = getComposerDeployScriptMap({
        template: "hono",
        packageManager,
        projectName: "matrix-app",
        useComposerPostgres: true,
      });

      expect(scripts["composer:deploy"]).toBe(platformDeployCommands[packageManager]);
      expect(scripts["composer:database:setup"]).toBe(
        `${packageManager === "bun" ? "bun" : "node"} scripts/setup-composer-postgres.mjs`,
      );
      expect(scripts.deploy).toBe(
        `${packageManager} run build && ${packageManager} run composer:deploy && ${packageManager} run composer:database:setup`,
      );
    });
  }
});

describe("Prisma CLI JSON output", () => {
  test("reads the consolidated CLI result event", () => {
    const output = [
      JSON.stringify({ kind: "message", text: "Checking authentication" }),
      JSON.stringify({
        kind: "result",
        envelope: {
          ok: true,
          result: { authenticated: true },
        },
      }),
    ].join("\n");

    expect(parsePrismaCliEnvelope(output)).toEqual({
      ok: true,
      result: { authenticated: true },
    });
  });

  test("keeps compatibility with the previous direct envelope", () => {
    expect(parsePrismaCliEnvelope('{"ok":true,"result":{"id":"db_123"}}')).toEqual({
      ok: true,
      result: { id: "db_123" },
    });
  });

  test("rejects output without a result envelope", () => {
    expect(() => parsePrismaCliEnvelope("not json")).toThrow(
      "Prisma CLI returned output that is not a valid result envelope.",
    );
  });
});

test("fills an empty pnpm overrides mapping", async () => {
  const projectDir = path.join(testRoot, "pnpm-null-overrides");
  await fs.ensureDir(projectDir);
  await fs.writeFile(
    path.join(projectDir, "pnpm-workspace.yaml"),
    'packages:\n  - "."\noverrides:\n',
    "utf8",
  );

  await scaffoldCreateTemplate({
    projectDir,
    projectName: "matrix-app",
    template: "hono",
    provider: "postgresql",
    packageManager: "pnpm",
    composerPostgres: true,
  });

  const workspace = await fs.readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8");
  expect(workspace).toContain('"@effect/platform-node": 4.0.0-beta.93');
});

test("preserves an existing pnpm override without creating a duplicate key", async () => {
  const projectDir = path.join(testRoot, "pnpm-existing-override");
  await fs.ensureDir(projectDir);
  await fs.writeFile(
    path.join(projectDir, "pnpm-workspace.yaml"),
    "packages:\n  - .\noverrides:\n  '@effect/sql-pg': 4.0.0-beta.90\n",
    "utf8",
  );

  await scaffoldCreateTemplate({
    projectDir,
    projectName: "matrix-app",
    template: "hono",
    provider: "postgresql",
    packageManager: "pnpm",
    composerPostgres: true,
  });

  const workspace = await fs.readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8");
  const parsed = parse(workspace) as { overrides: Record<string, string> };
  expect(parsed.overrides["@effect/sql-pg"]).toBe("4.0.0-beta.90");
  expect(workspace.match(/@effect\/sql-pg/g)).toHaveLength(1);
});

test("adds a pnpm override when the package only appears in another section", async () => {
  const projectDir = path.join(testRoot, "pnpm-catalog-only");
  await fs.ensureDir(projectDir);
  await fs.writeFile(
    path.join(projectDir, "pnpm-workspace.yaml"),
    "packages:\n  - .\ncatalog:\n  '@effect/sql-pg': 4.0.0-beta.90\n",
    "utf8",
  );

  await scaffoldCreateTemplate({
    projectDir,
    projectName: "matrix-app",
    template: "hono",
    provider: "postgresql",
    packageManager: "pnpm",
    composerPostgres: true,
  });

  const workspace = await fs.readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8");
  const parsed = parse(workspace) as {
    catalog: Record<string, string>;
    overrides: Record<string, string>;
  };
  expect(parsed.catalog["@effect/sql-pg"]).toBe("4.0.0-beta.90");
  expect(parsed.overrides["@effect/sql-pg"]).toBe("4.0.0-beta.93");
});
