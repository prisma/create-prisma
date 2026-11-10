import { Effect } from "effect";

import { CommandRunner } from "../../services/command-runner";
import { isOlderVersion, parsePackageManagerVersion } from "../../utils/package-manager";

// Bun 1.3.13 and older mis-transpile React 19.3's server renderer, so every SSR request fails.
export const MINIMUM_LOCAL_BUN_VERSION = [1, 3, 14] as const;

export const checkLocalBunEffect = Effect.fn("PrismaSetup.checkLocalBun")(function* (cwd: string) {
  const runner = yield* CommandRunner;
  const result = yield* runner
    .run({ command: "bun", args: ["--version"], cwd })
    .pipe(Effect.orElseSucceed(() => undefined));
  const version =
    result?.exitCode === 0 ? parsePackageManagerVersion("bun", result.stdout.trim()) : undefined;
  if (!version || !isOlderVersion(version.parts, MINIMUM_LOCAL_BUN_VERSION)) return undefined;
  return `Bun ${version.version} is on your PATH. Prisma Composer runs your app locally with it, and Bun older than ${MINIMUM_LOCAL_BUN_VERSION.join(".")} cannot run some apps, such as React 19.3 server rendering. Run \`bun upgrade\` before \`dev:composer\`.`;
});
