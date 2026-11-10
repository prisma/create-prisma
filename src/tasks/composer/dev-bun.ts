import { Effect, Option } from "effect";

import { CommandRunner } from "../../services/command-runner";
import type { PackageManager } from "../../types";
import type { ChildProcessFailure } from "../../utils/child-process-failure";
import {
  getRunScriptCommand,
  isOlderVersion,
  parsePackageManagerVersion,
} from "../../utils/package-manager";

// Composer dev runs the app with the Bun on PATH. Bun 1.3.13 and older mis-transpile
// React 19.3's server renderer, so every server-rendered request fails.
export const MINIMUM_COMPOSER_DEV_BUN_VERSION = [1, 3, 14] as const;

const BUN_VERSION_TIMEOUT = "3 seconds";

type BunProbe = { installed: false } | { installed: true; version: string | undefined };

const probe = (failure: ChildProcessFailure | undefined, version?: string): BunProbe =>
  failure === "command_not_found" ? { installed: false } : { installed: true, version };

export const getComposerDevBunWarningEffect = Effect.fn("Composer.devBunWarning")(function* (
  cwd: string,
  packageManager: PackageManager,
) {
  const runner = yield* CommandRunner;
  const bun = yield* runner.run({ command: "bun", args: ["--version"], cwd }).pipe(
    Effect.map((result) =>
      probe(result.childProcessFailure, result.exitCode === 0 ? result.stdout.trim() : undefined),
    ),
    Effect.catch((error) => Effect.succeed(probe(error.childProcessFailure))),
    Effect.timeoutOption(BUN_VERSION_TIMEOUT),
    Effect.map(Option.getOrUndefined),
  );
  const devCommand = `\`${getRunScriptCommand(packageManager, "dev:composer")}\``;
  if (bun?.installed === false) {
    return `Bun is not on your PATH. Prisma Composer runs your app locally with Bun. Install it from https://bun.sh before ${devCommand}.`;
  }
  const version = bun?.version ? parsePackageManagerVersion("bun", bun.version) : undefined;
  if (!version || !isOlderVersion(version.parts, MINIMUM_COMPOSER_DEV_BUN_VERSION)) {
    return undefined;
  }
  return `Bun ${version.version} is on your PATH. Prisma Composer runs your app locally with it, and Bun older than ${MINIMUM_COMPOSER_DEV_BUN_VERSION.join(".")} cannot run some apps, such as React 19.3 server rendering. Run \`bun upgrade\` before ${devCommand}.`;
});
