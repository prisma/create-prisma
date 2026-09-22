import { Effect, FileSystem } from "effect";
import path from "node:path";

import { getDependencyVersion } from "../constants/dependencies";
import { CreateFailure } from "../create-outcome";
import { applicationRuntime } from "../runtime";
import { CommandRunner } from "../services/command-runner";
import { packageManagers, type PackageManager } from "../types";
import { getErrorMessage } from "./errors";

type CommandAndArgs = {
  command: string;
  args: string[];
};

type RuntimeScriptKind = "dev" | "build" | "start";
type RuntimeScriptOptions = {
  sourceEntrypoint: string;
  builtEntrypoint?: string;
};

// Deno 2.9 rejects packages published within the previous 24 hours by default.
// Scaffolding must be able to resolve the freshly published, explicitly pinned Prisma release.
const DENO_ALLOW_FRESH_DEPENDENCIES = "--minimum-dependency-age=0";

const packageManagerManifestValues = {
  npm: "npm@11.6.0",
  pnpm: "pnpm@11.21.0",
  yarn: "yarn@4.13.0",
  bun: "bun@1.4.1",
} as const;

type PackageManagerVersion = readonly [major: number, minor: number, patch: number];

const packageManagerChecks: Record<
  PackageManager,
  {
    name: string;
    versionArgs: string[];
    install: string;
    minimum?: { version: PackageManagerVersion; guidance: string };
  }
> = {
  npm: {
    name: "npm",
    versionArgs: ["--version"],
    install: "Install Node.js from https://nodejs.org to get npm",
    // https://github.com/npm/cli/pull/8448 shipped in npm 11.6.0.
    minimum: {
      version: [11, 6, 0],
      guidance:
        "Older npm releases can crash while resolving Prisma dependencies. Run npm install --global npm@11, then retry create-prisma.",
    },
  },
  pnpm: {
    name: "pnpm",
    versionArgs: ["--version"],
    install: "Install it from https://pnpm.io/installation",
  },
  yarn: {
    name: "Yarn",
    versionArgs: ["--version"],
    install: "Install it with Corepack (https://yarnpkg.com/corepack)",
    minimum: {
      version: [2, 0, 0],
      guidance: `Generated projects use ${packageManagerManifestValues.yarn}, which Yarn 1 refuses to install. Enable Corepack (https://yarnpkg.com/corepack) or install Yarn 4, then retry create-prisma, or choose another package manager with --package-manager.`,
    },
  },
  bun: {
    name: "Bun",
    versionArgs: ["--version"],
    install: "Install it from https://bun.sh",
  },
  deno: {
    name: "Deno",
    // `deno -V` prints one line; `deno --version` adds the V8 and TypeScript versions.
    versionArgs: ["-V"],
    install: "Install it from https://docs.deno.com/runtime/getting_started/installation",
  },
};

const PACKAGE_MANAGER_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parsePackageManagerVersion(
  packageManager: PackageManager,
  version: string,
): PackageManagerVersion | undefined {
  const prefix = `${packageManager} `;
  const match = PACKAGE_MANAGER_VERSION_PATTERN.exec(
    version.startsWith(prefix) ? version.slice(prefix.length) : version,
  );
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

function isOlderVersion(version: PackageManagerVersion, minimum: PackageManagerVersion): boolean {
  for (const [index, part] of version.entries()) {
    if (part !== minimum[index]) return part < minimum[index]!;
  }
  return false;
}

const probePackageManagerEffect = Effect.fn("PackageManager.probe")(function* (
  packageManager: PackageManager,
  cwd: string,
) {
  const runner = yield* CommandRunner;
  const { name, versionArgs, install, minimum } = packageManagerChecks[packageManager];
  const result = yield* runner.runChecked({ command: packageManager, args: versionArgs, cwd }).pipe(
    Effect.mapError((cause) =>
      cause.childProcessFailure === "command_not_found"
        ? new CreateFailure({
            stage: "validate_input",
            reason: "package_manager_not_found",
            message: `${name} is not installed or is not on your PATH. ${install}, then retry create-prisma, or choose another package manager with --package-manager.`,
            cause,
          })
        : new CreateFailure({
            stage: "validate_input",
            reason: "package_manager_check_failed",
            message: `Could not run ${[packageManager, ...versionArgs].join(" ")}: ${getErrorMessage(cause)}`,
            cause,
          }),
    ),
  );
  const output = result.stdout.trim();
  const version = parsePackageManagerVersion(packageManager, output);
  if (!version) {
    return yield* new CreateFailure({
      stage: "validate_input",
      reason: "package_manager_check_failed",
      message: `Could not determine the installed ${name} version: ${output}`,
    });
  }
  if (minimum && isOlderVersion(version, minimum.version)) {
    return yield* new CreateFailure({
      stage: "validate_input",
      reason: "unsupported_package_manager_version",
      message: `${name} ${version.join(".")} is unsupported. Required: ${name} ${minimum.version.join(".")} or newer. ${minimum.guidance}`,
    });
  }
});

// The reported version depends on the directory's "packageManager", so probe in a temporary
// directory carrying the generated project's value.
export const verifyPackageManagerEffect = Effect.fn("PackageManager.verify")(function* (
  packageManager: PackageManager,
) {
  const fs = yield* FileSystem.FileSystem;
  const probeDir = yield* fs.makeTempDirectoryScoped({ prefix: "create-prisma-" }).pipe(
    Effect.tap((directory) =>
      fs.writeFileString(
        path.join(directory, "package.json"),
        JSON.stringify({
          name: "create-prisma-probe",
          private: true,
          packageManager: getPackageManagerManifestValue(packageManager),
        }),
      ),
    ),
    Effect.mapError(
      (cause) =>
        new CreateFailure({
          stage: "validate_input",
          reason: "package_manager_check_failed",
          message: `Could not prepare a directory to check ${packageManagerChecks[packageManager].name}: ${getErrorMessage(cause)}`,
          cause,
        }),
    ),
  );
  yield* probePackageManagerEffect(packageManager, probeDir);
}, Effect.scoped);

function parseUserAgent(userAgent: string | undefined): PackageManager | null {
  if (userAgent?.startsWith("pnpm")) {
    return "pnpm";
  }

  if (userAgent?.startsWith("yarn")) {
    return "yarn";
  }

  if (userAgent?.startsWith("bun")) {
    return "bun";
  }

  if (userAgent?.startsWith("deno")) {
    return "deno";
  }

  if (userAgent?.startsWith("npm")) {
    return "npm";
  }

  return null;
}

function parsePackageManagerField(packageManagerField: unknown): PackageManager | null {
  if (typeof packageManagerField !== "string" || packageManagerField.length === 0) {
    return null;
  }

  const managerName = packageManagerField.split("@")[0];
  return packageManagers.includes(managerName as PackageManager)
    ? (managerName as PackageManager)
    : null;
}

const detectFromPackageJson = Effect.fn("PackageManager.detectFromPackageJson")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(yield* fs.exists(packageJsonPath))) {
    return null;
  }

  const packageJsonSource = yield* fs
    .readFileString(packageJsonPath)
    .pipe(Effect.catch(() => Effect.succeed("")));
  const packageJson = yield* Effect.try(
    () => JSON.parse(packageJsonSource) as Record<string, unknown>,
  ).pipe(Effect.catch(() => Effect.succeed(null)));
  return packageJson ? parsePackageManagerField(packageJson.packageManager) : null;
});

const detectFromDenoConfig = Effect.fn("PackageManager.detectFromDenoConfig")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const configFile of ["deno.json", "deno.jsonc"]) {
    if (yield* fs.exists(path.join(projectDir, configFile))) {
      return "deno";
    }
  }

  return null;
});

const detectFromLockfile = Effect.fn("PackageManager.detectFromLockfile")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const lockfileChecks: Array<{ manager: PackageManager; lockfile: string }> = [
    { manager: "pnpm", lockfile: "pnpm-lock.yaml" },
    { manager: "yarn", lockfile: "yarn.lock" },
    { manager: "bun", lockfile: "bun.lockb" },
    { manager: "bun", lockfile: "bun.lock" },
    { manager: "npm", lockfile: "package-lock.json" },
    { manager: "npm", lockfile: "npm-shrinkwrap.json" },
    { manager: "deno", lockfile: "deno.lock" },
  ];

  for (const check of lockfileChecks) {
    if (yield* fs.exists(path.join(projectDir, check.lockfile))) {
      return check.manager;
    }
  }

  return null;
});

export const detectPackageManagerEffect = Effect.fn("PackageManager.detect")(function* (
  projectDir = process.cwd(),
) {
  const fromPackageJson = yield* detectFromPackageJson(projectDir);
  if (fromPackageJson) {
    return fromPackageJson;
  }

  const fromLockfile = yield* detectFromLockfile(projectDir);
  if (fromLockfile) {
    return fromLockfile;
  }

  const fromDenoConfig = yield* detectFromDenoConfig(projectDir);
  if (fromDenoConfig) {
    return fromDenoConfig;
  }

  const fromUserAgent = parseUserAgent(process.env.npm_config_user_agent);
  if (fromUserAgent) {
    return fromUserAgent;
  }

  return "npm";
});

export function detectPackageManager(projectDir = process.cwd()): Promise<PackageManager> {
  return applicationRuntime.runPromise(detectPackageManagerEffect(projectDir));
}

export function getPackageManagerManifestValue(
  packageManager: PackageManager | undefined,
): string | undefined {
  if (!packageManager) {
    return undefined;
  }

  if (packageManager === "deno") {
    return undefined;
  }

  return packageManagerManifestValues[packageManager];
}

export function getInstallCommand(packageManager: PackageManager): string {
  if (packageManager === "deno") {
    return "deno install";
  }

  return `${packageManager} install`;
}

export function getRunScriptCommand(packageManager: PackageManager, scriptName: string): string {
  switch (packageManager) {
    case "deno":
      return `deno task ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn run ${scriptName}`;
    case "npm":
    default:
      return `npm run ${scriptName}`;
  }
}

export function getRuntimeScriptCommand(
  packageManager: PackageManager,
  kind: RuntimeScriptKind,
  options: RuntimeScriptOptions,
): string {
  const { sourceEntrypoint, builtEntrypoint } = options;

  if (packageManager === "deno") {
    switch (kind) {
      case "dev":
        return `deno run -A --env-file=.env --watch ${sourceEntrypoint}`;
      case "build":
        return `deno check ${sourceEntrypoint}`;
      case "start":
        return `deno run -A --env-file=.env ${sourceEntrypoint}`;
    }
  }

  if (packageManager === "bun") {
    switch (kind) {
      case "dev":
        return `bun --watch ${sourceEntrypoint}`;
      case "build":
        return "tsc --noEmit";
      case "start":
        return `bun ${sourceEntrypoint}`;
    }
  }

  switch (kind) {
    case "dev":
      return `tsx watch ${sourceEntrypoint}`;
    case "build":
      return "tsc";
    case "start":
      return builtEntrypoint ? `node ${builtEntrypoint}` : `tsx ${sourceEntrypoint}`;
  }
}

export function getInstallArgs(packageManager: PackageManager): CommandAndArgs {
  if (packageManager === "deno") {
    return {
      command: "deno",
      args: ["install", DENO_ALLOW_FRESH_DEPENDENCIES],
    };
  }

  return {
    command: packageManager,
    args: ["install"],
  };
}

export function getPackageExecutionArgs(
  packageManager: PackageManager,
  commandArgs: string[],
): CommandAndArgs {
  switch (packageManager) {
    case "deno": {
      const [packageName, ...args] = commandArgs;
      if (!packageName) {
        throw new Error("Package execution requires a package name.");
      }
      return {
        command: "deno",
        args: ["run", "-A", DENO_ALLOW_FRESH_DEPENDENCIES, `npm:${packageName}`, ...args],
      };
    }
    case "pnpm":
      return { command: "pnpm", args: ["dlx", ...commandArgs] };
    case "yarn":
      return { command: "yarn", args: ["dlx", ...commandArgs] };
    case "bun":
      return { command: "bunx", args: [...commandArgs] };
    case "npm":
    default:
      return { command: "npx", args: ["--yes", ...commandArgs] };
  }
}

export function getPackageExecutionCommand(
  packageManager: PackageManager,
  commandArgs: string[],
): string {
  const execution = getPackageExecutionArgs(packageManager, commandArgs);
  return [execution.command, ...execution.args].join(" ");
}

export function getLocalPackageBinaryArgs(
  packageManager: PackageManager,
  binaryName: string,
  binaryArgs: string[],
): CommandAndArgs {
  switch (packageManager) {
    case "deno":
      return {
        command: "deno",
        args: [
          "run",
          "-A",
          "--frozen",
          `npm:${binaryName}@${getDependencyVersion(binaryName) ?? "latest"}`,
          ...binaryArgs,
        ],
      };
    case "pnpm":
      return { command: "pnpm", args: ["exec", binaryName, ...binaryArgs] };
    case "yarn":
      return { command: "yarn", args: [binaryName, ...binaryArgs] };
    case "bun":
      return { command: "bun", args: [binaryName, ...binaryArgs] };
    case "npm":
    default:
      return {
        command: "npm",
        args: ["exec", "--offline", "--yes=false", "--", binaryName, ...binaryArgs],
      };
  }
}

export function getLocalPackageBinaryCommand(
  packageManager: PackageManager,
  binaryName: string,
  binaryArgs: string[],
): string {
  const execution = getLocalPackageBinaryArgs(packageManager, binaryName, binaryArgs);
  return [execution.command, ...execution.args].join(" ");
}

export function getRunScriptArgs(
  packageManager: PackageManager,
  scriptName: string,
): CommandAndArgs {
  switch (packageManager) {
    case "deno":
      return { command: "deno", args: ["task", scriptName] };
    case "bun":
      return { command: "bun", args: ["run", scriptName] };
    case "pnpm":
      return { command: "pnpm", args: ["run", scriptName] };
    case "yarn":
      return { command: "yarn", args: ["run", scriptName] };
    case "npm":
    default:
      return { command: "npm", args: ["run", scriptName] };
  }
}
