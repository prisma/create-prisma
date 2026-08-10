import { afterAll, describe, expect, test } from "bun:test";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

import {
  createTemplates,
  packageManagers,
  type CreateTemplate,
  type PackageManager,
} from "../types";
import { getComposerDeployScriptMap } from "../tasks/deploy-with-composer";
import { scaffoldCreateTemplate } from "./render-create-template";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "create-prisma-templates-"));

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

          const packageJson = await fs.readJson(path.join(projectDir, "package.json"));
          const moduleSource = await fs.readFile(path.join(projectDir, "module.ts"), "utf8");
          const databaseSetupPath = path.join(projectDir, "scripts/setup-composer-postgres.mjs");

          expect(packageJson.packageManager).toStartWith(`${packageManager}@`);
          expect(
            await fs.pathExists(path.join(projectDir, "prisma-composer.config.ts")),
          ).toBeTrue();
          expect(await fs.pathExists(path.join(projectDir, "prisma.compute.ts"))).toBeFalse();
          expect(await fs.pathExists(path.join(projectDir, "deno.json"))).toBeFalse();

          if (composerPostgres) {
            expect(moduleSource).toContain("provision(postgres(");
            expect(moduleSource).not.toContain("envSecret(");
            expect(await fs.pathExists(databaseSetupPath)).toBeTrue();
            const setupSource = await fs.readFile(databaseSetupPath, "utf8");
            expect(setupSource).toContain('runPrisma(["migrate", "deploy"], databaseUrl)');
            expect(setupSource).not.toContain('runPrisma(["migrate", "dev"]');
            expect(setupSource).not.toContain("./node_modules/.bin/prisma");
            expect(setupSource).toContain('shell: process.platform === "win32"');
            expect(setupSource).toContain("Prisma CLI returned output that is not valid JSON.");
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

      expect(scripts["composer:deploy"]).toBe("prisma-composer deploy module.ts");
      expect(scripts["composer:database:setup"]).toBe(
        `${packageManager === "bun" ? "bun" : "node"} scripts/setup-composer-postgres.mjs`,
      );
      expect(scripts.deploy).toBe(
        `${packageManager} run build && ${packageManager} run composer:deploy && ${packageManager} run composer:database:setup`,
      );
    });
  }
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
