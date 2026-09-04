import { Effect, FileSystem } from "effect";
import path from "node:path";

import {
  getCreateTemplateDependencies,
  getDependencyVersion,
  PRISMA_DENO_CLI_PACKAGE,
} from "../constants/dependencies";
import { getDbPackages } from "../constants/db-packages";
import { applicationRuntime } from "../runtime";
import type { AuthoringStyle, CreateTemplate, DatabaseProvider, PackageManager } from "../types";
import { getInstallArgs, getRunScriptCommand } from "../utils/package-manager";
import { runSetupCommand } from "../utils/run-command";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  resolutions?: Record<string, string>;
  overrides?: Record<string, string>;
  [key: string]: unknown;
};

function getPrismaScriptMap(packageManager: PackageManager): Record<string, string> {
  if (packageManager === "deno") {
    const prismaCommand = (needsDatabase: boolean, ...args: string[]) =>
      [
        "deno run -A",
        ...(needsDatabase ? ["--env-file=.env"] : []),
        `npm:${PRISMA_DENO_CLI_PACKAGE}`,
        ...args,
      ].join(" ");

    return {
      "contract:emit": prismaCommand(false, "contract", "emit"),
      "db:init": prismaCommand(true, "db", "init"),
      "db:update": prismaCommand(true, "db", "update"),
      "db:verify": prismaCommand(true, "db", "verify"),
      "migration:plan": prismaCommand(true, "migration", "plan"),
      migrate: prismaCommand(true, "db", "migrate"),
      "migration:status": prismaCommand(true, "migration", "status"),
      "migration:show": prismaCommand(true, "migration", "show"),
    };
  }

  const prismaCommand = (...args: string[]) => ["prisma", ...args].join(" ");
  return {
    "contract:emit": prismaCommand("contract", "emit"),
    "db:init": prismaCommand("db", "init"),
    "db:update": prismaCommand("db", "update"),
    "db:verify": prismaCommand("db", "verify"),
    "migration:plan": prismaCommand("migration", "plan"),
    migrate: prismaCommand("db", "migrate"),
    "migration:status": prismaCommand("migration", "status"),
    "migration:show": prismaCommand("migration", "show"),
    "skills:sync": `${prismaCommand("skills", "sync")} || exit 0`,
  };
}

export function getComposerScriptMap(packageManager: PackageManager): Record<string, string> {
  if (packageManager === "deno") return {};
  const composerCommand = (subcommand: "dev" | "deploy") =>
    ["prisma", subcommand, "module.ts"].join(" ");
  return {
    "composer:dev": composerCommand("dev"),
    "composer:deploy": composerCommand("deploy"),
    deploy: `${getRunScriptCommand(packageManager, "build")} && ${getRunScriptCommand(packageManager, "composer:deploy")}`,
    "dev:composer": `${getRunScriptCommand(packageManager, "build")} && ${getRunScriptCommand(packageManager, "composer:dev")}`,
  };
}

const unique = (items: string[]) => [...new Set(items)];
const sortRecord = (record: Record<string, string>) =>
  Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));

const readPackageJson = Effect.fn("Dependencies.readPackageJson")(function* (
  packageJsonPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(packageJsonPath);
  return yield* Effect.try({
    try: () => JSON.parse(source) as PackageJson,
    catch: (cause) => new Error(`Invalid package.json at ${packageJsonPath}`, { cause }),
  });
});

const writePackageJson = Effect.fn("Dependencies.writePackageJson")(function* (
  packageJsonPath: string,
  packageJson: PackageJson,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
});

export const addPackageDependencyEffect = Effect.fn("Dependencies.add")(function* (opts: {
  dependencies?: string[];
  devDependencies?: string[];
  customDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  scriptMode?: "if-missing";
  projectDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const dependencies = opts.dependencies ?? [];
  const devDependencies = opts.devDependencies ?? [];
  const customDependencies = opts.customDependencies ?? {};
  const scripts = opts.scripts ?? {};
  const packageJsonPath = path.join(opts.projectDir, "package.json");
  if (!(yield* fs.exists(packageJsonPath))) {
    return yield* Effect.fail(
      new Error(
        `No package.json found in ${opts.projectDir}. Run this command inside an existing JavaScript/TypeScript project.`,
      ),
    );
  }

  const packageJson = yield* readPackageJson(packageJsonPath);
  packageJson.dependencies ??= {};
  packageJson.devDependencies ??= {};
  packageJson.scripts ??= {};

  for (const packageName of unique(dependencies)) {
    const version = getDependencyVersion(packageName);
    if (!version)
      return yield* Effect.fail(
        new Error(`Dependency ${packageName} is missing from the version map.`),
      );
    packageJson.dependencies[packageName] = version;
  }
  for (const packageName of unique(devDependencies)) {
    const version = getDependencyVersion(packageName);
    if (!version)
      return yield* Effect.fail(
        new Error(`Dependency ${packageName} is missing from the version map.`),
      );
    packageJson.devDependencies[packageName] = version;
  }
  Object.assign(packageJson.dependencies, customDependencies);
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (
      opts.scriptMode === "if-missing" &&
      typeof packageJson.scripts[scriptName] === "string" &&
      packageJson.scripts[scriptName].trim().length > 0
    ) {
      continue;
    }
    packageJson.scripts[scriptName] = command;
  }

  packageJson.dependencies = sortRecord(packageJson.dependencies);
  packageJson.devDependencies = sortRecord(packageJson.devDependencies);
  packageJson.scripts = sortRecord(packageJson.scripts);
  yield* writePackageJson(packageJsonPath, packageJson);
});

export const writePrismaDependenciesEffect = Effect.fn("Dependencies.writePrisma")(function* (
  provider: DatabaseProvider,
  packageManager: PackageManager,
  _authoring: AuthoringStyle,
  projectDir = process.cwd(),
) {
  const dependencies = [getDbPackages(provider)];
  if (provider === "postgres" && packageManager !== "deno") dependencies.push("temporal-polyfill");
  if (provider === "mongo") dependencies.push("arktype", "mongodb");
  if (packageManager === "deno") dependencies.push("dotenv");
  yield* addPackageDependencyEffect({
    dependencies,
    devDependencies: ["@types/node", "prisma"],
    scripts: getPrismaScriptMap(packageManager),
    projectDir,
  });
});

export const writeCreateTemplateDependenciesEffect = Effect.fn("Dependencies.writeTemplate")(
  function* (opts: {
    template: CreateTemplate;
    packageManager: PackageManager;
    projectDir?: string;
  }) {
    const projectDir = opts.projectDir ?? process.cwd();
    if (opts.packageManager === "deno") return;

    for (const target of getCreateTemplateDependencies(opts.template, opts.packageManager)) {
      yield* addPackageDependencyEffect({
        dependencies: target.dependencies,
        devDependencies: target.devDependencies,
        customDependencies: target.customDependencies,
        scripts: getComposerScriptMap(opts.packageManager),
        projectDir: path.join(projectDir, path.dirname(target.packageJsonPath)),
      });
    }

    const packageJsonPath = path.join(projectDir, "package.json");
    const packageJson = yield* readPackageJson(packageJsonPath);
    const effectVersion = getDependencyVersion("effect");
    if (!effectVersion)
      return yield* Effect.fail(new Error("Dependency effect is missing from the version map."));
    if (opts.packageManager === "yarn") {
      packageJson.resolutions = { ...packageJson.resolutions, effect: effectVersion };
    } else if (opts.packageManager !== "pnpm") {
      packageJson.overrides = { ...packageJson.overrides, effect: effectVersion };
    }
    yield* writePackageJson(packageJsonPath, packageJson);
  },
);

export const installProjectDependenciesEffect = Effect.fn("Dependencies.install")(function* (
  packageManager: PackageManager,
  projectDir = process.cwd(),
  options: { verbose?: boolean; json?: boolean } = {},
) {
  const installCommand = getInstallArgs(packageManager);
  yield* runSetupCommand({
    command: installCommand.command,
    args: installCommand.args,
    cwd: projectDir,
    ...(packageManager === "yarn" ? { env: { YARN_ENABLE_IMMUTABLE_INSTALLS: "false" } } : {}),
    verbose: options.verbose === true,
    json: options.json === true,
  });
});

export const addPackageDependency = (opts: Parameters<typeof addPackageDependencyEffect>[0]) =>
  applicationRuntime.runPromise(addPackageDependencyEffect(opts));
export const writePrismaDependencies = (
  ...args: Parameters<typeof writePrismaDependenciesEffect>
) => applicationRuntime.runPromise(writePrismaDependenciesEffect(...args));
export const writeCreateTemplateDependencies = (
  opts: Parameters<typeof writeCreateTemplateDependenciesEffect>[0],
) => applicationRuntime.runPromise(writeCreateTemplateDependenciesEffect(opts));
export const installProjectDependencies = (
  ...args: Parameters<typeof installProjectDependenciesEffect>
) => applicationRuntime.runPromise(installProjectDependenciesEffect(...args));
