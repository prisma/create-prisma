// Output captured from real failed `install` runs with piped stdio, trimmed, with the
// local home and project paths replaced. The remaining paths, URLs and package names
// are what a user's output contains, which is exactly what must never reach telemetry.

export type PackageManagerOutputFixture = {
  name: string;
  command: string;
  stdout: string;
  stderr: string;
  expected: string | undefined;
};

const lines = (...parts: string[]) => parts.join("\n");

export const packageManagerOutputFixtures: PackageManagerOutputFixture[] = [
  {
    name: "npm 11: version does not exist",
    command: "npm",
    stdout: "",
    stderr: lines(
      "npm error code ETARGET",
      "npm error notarget No matching version found for left-pad@99.99.99.",
      "npm error notarget In most cases you or one of your dependencies are requesting a package version that doesn't exist.",
      "npm error A complete log of this run can be found in: /Users/jane/.npm/_logs/2026-09-21T10_20_59_996Z-debug-0.log",
    ),
    expected: "ETARGET",
  },
  {
    name: "npm 11: package does not exist",
    command: "npm",
    stdout: "",
    stderr: lines(
      "npm error code E404",
      "npm error 404 Not Found - GET https://registry.npmjs.org/create-prisma-telemetry-probe-does-not-exist - Not found",
      "npm error 404",
      "npm error 404  The requested resource 'create-prisma-telemetry-probe-does-not-exist@1.0.0' could not be found or you do not have permission to access it.",
      "npm error A complete log of this run can be found in: /Users/jane/.npm/_logs/2026-09-21T10_22_26_869Z-debug-0.log",
    ),
    expected: "E404",
  },
  {
    name: "npm 11: registry unreachable",
    command: "npm",
    stdout: "",
    stderr: lines(
      "npm error code ECONNREFUSED",
      "npm error syscall connect",
      "npm error errno ECONNREFUSED",
      "npm error FetchError: request to http://127.0.0.1:9/left-pad failed, reason: connect ECONNREFUSED 127.0.0.1:9",
      "npm error     at ClientRequest.<anonymous> (/Users/jane/.local/share/mise/installs/node/26.7.0/lib/node_modules/npm/node_modules/minipass-fetch/lib/index.js:130:14)",
      "npm error   code: 'ECONNREFUSED',",
      "npm error   address: '127.0.0.1',",
      "npm error If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'",
    ),
    expected: "ECONNREFUSED",
  },
  {
    name: "npm 11: lifecycle script failed with a numeric status",
    command: "npm",
    stdout: lines("", "> postinstall", "> exit 3", ""),
    stderr: lines(
      "npm error code 3",
      "npm error path /Users/jane/projects/my-app",
      "npm error command failed",
      "npm error command sh -c exit 3",
    ),
    expected: undefined,
  },
  {
    name: "npm 8: legacy error prefix",
    command: "npm",
    stdout: "",
    stderr: lines(
      "npm ERR! code ETARGET",
      "npm ERR! notarget No matching version found for left-pad@99.99.99.",
      "",
      "npm ERR! A complete log of this run can be found in:",
      "npm ERR!     /Users/jane/.npm/_logs/2026-09-21T10_24_12_497Z-debug-0.log",
    ),
    expected: "ETARGET",
  },
  {
    name: "pnpm 11: version does not exist",
    command: "pnpm",
    stdout: lines(
      "[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for left-pad@99.99.99 while fetching it from https://registry.npmjs.org/",
      "",
      "This error happened while installing a direct dependency of /Users/jane/projects/my-app",
      "",
      'The latest release of left-pad is "1.3.0".',
    ),
    stderr: "",
    expected: "ERR_PNPM_NO_MATCHING_VERSION",
  },
  {
    name: "pnpm 11: package does not exist",
    command: "pnpm",
    stdout: lines(
      "[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/create-prisma-telemetry-probe-does-not-exist: Not Found - 404",
      "",
      "This error happened while installing a direct dependency of /Users/jane/projects/my-app",
      "",
      "No authorization header was set for the request.",
    ),
    stderr: "",
    expected: "ERR_PNPM_FETCH_404",
  },
  {
    name: "pnpm 11: registry unreachable after retry warnings",
    command: "pnpm",
    stdout: lines(
      "[WARN] GET http://127.0.0.1:9/left-pad error (unknown). Will retry in 10 seconds. 2 retries left.",
      "[WARN] GET http://127.0.0.1:9/left-pad error (unknown). Will retry in 1 minute. 1 retries left.",
      "[ERR_PNPM_META_FETCH_FAIL] GET http://127.0.0.1:9/left-pad: fetch failed",
      "",
      "This error happened while installing a direct dependency of /Users/jane/projects/my-app",
    ),
    stderr: "",
    expected: "ERR_PNPM_META_FETCH_FAIL",
  },
  {
    name: "pnpm 11: lifecycle script failed",
    command: "pnpm",
    stdout: lines("Already up to date", "[ELIFECYCLE] Command failed with exit code 3."),
    stderr: "$ exit 3",
    expected: "ELIFECYCLE",
  },
  {
    name: "pnpm 10: legacy thin-space padding",
    command: "pnpm",
    stdout: lines(
      "\u2009ERR_PNPM_NO_MATCHING_VERSION\u2009 No matching version found for left-pad@99.99.99 while fetching it from https://registry.npmjs.org/",
      "",
      "This error happened while installing a direct dependency of /Users/jane/projects/my-app",
    ),
    stderr: "",
    expected: "ERR_PNPM_NO_MATCHING_VERSION",
  },
  {
    name: "pnpm 10: forced colour",
    command: "pnpm",
    stdout:
      "\u001b[41m\u001b[30m\u2009ERR_PNPM_NO_MATCHING_VERSION\u2009\u001b[39m\u001b[49m \u001b[31mNo matching version found for left-pad@99.99.99\u001b[39m",
    stderr: "",
    expected: "ERR_PNPM_NO_MATCHING_VERSION",
  },
  {
    name: "pnpm 10: lifecycle script failed before a trailing warning",
    command: "pnpm",
    stdout: lines(
      "Already up to date",
      "",
      "> probe@ postinstall /Users/jane/projects/my-app",
      "> exit 3",
      "",
      "\u2009ELIFECYCLE\u2009 Command failed with exit code 3.",
      "\u2009WARN\u2009  Local package.json exists, but node_modules missing, did you mean to install?",
    ),
    stderr: "",
    expected: "ELIFECYCLE",
  },
  {
    name: "Yarn 4: version does not exist",
    command: "yarn",
    stdout: lines(
      "➤ YN0000: · Yarn 4.18.0",
      "➤ YN0000: ┌ Resolution step",
      "➤ YN0082: │ left-pad@npm:99.99.99: No candidates found",
      "➤ YN0000: └ Completed in 0s 399ms",
      "➤ YN0000: · Failed with errors in 0s 403ms",
    ),
    stderr: "",
    expected: "YN0082",
  },
  {
    name: "Yarn 4: package does not exist",
    command: "yarn",
    stdout: lines(
      "➤ YN0000: · Yarn 4.18.0",
      "➤ YN0000: ┌ Resolution step",
      "➤ YN0035: │ create-prisma-telemetry-probe-does-not-exist@npm:1.0.0: Package not found",
      "➤ YN0035: │   Response Code: 404 (Not Found)",
      "➤ YN0035: │   Request URL: https://registry.yarnpkg.com/create-prisma-telemetry-probe-does-not-exist",
      "➤ YN0000: └ Completed in 0s 344ms",
      "➤ YN0000: · Failed with errors in 0s 348ms",
    ),
    stderr: "",
    expected: "YN0035",
  },
  {
    name: "Yarn 4: lifecycle script failed after an informational message",
    command: "yarn",
    stdout: lines(
      "➤ YN0000: · Yarn 4.18.0",
      "➤ YN0000: ┌ Link step",
      "➤ YN0007: │ probe@workspace:. must be built because it never has been before or the last one failed",
      "➤ YN0009: │ probe@workspace:. couldn't be built successfully (exit code 3, logs can be found here: /private/var/folders/tg/xrj97k111zx156t1s_wpkxr40000gn/T/xfs-5b34503f/build.log)",
      "➤ YN0000: └ Completed",
      "➤ YN0000: · Failed with errors in 0s 20ms",
    ),
    stderr: "",
    expected: "YN0009",
  },
  {
    name: "Yarn 4: registry unreachable",
    command: "yarn",
    stdout: lines(
      "➤ YN0000: · Yarn 4.18.0",
      "➤ YN0000: ┌ Resolution step",
      "➤ YN0001: │ RequestError: connect ECONNREFUSED 127.0.0.1:9",
      "    at ClientRequest.<anonymous> (/Users/jane/.yarn/releases/yarn-4.18.0.cjs:148:14258)",
      "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:2017:16)",
      "➤ YN0000: └ Completed",
      "➤ YN0000: · Failed with errors in 0s 17ms",
    ),
    stderr: "",
    expected: "YN0001",
  },
  {
    name: "Yarn 1: prose only",
    command: "yarn",
    stdout: lines(
      "yarn install v1.22.22",
      "info No lockfile found.",
      "[1/4] Resolving packages...",
    ),
    stderr: 'error Couldn\'t find any versions for "left-pad" that matches "99.99.99"',
    expected: undefined,
  },
  {
    name: "Bun 1.4: prose only",
    command: "bun",
    stdout: "bun install v1.4.0 (34cbb9a40)",
    stderr: lines(
      "Resolving dependencies",
      'error: No version matching "99.99.99" found for specifier "left-pad" (but package exists)',
      "error: left-pad@99.99.99 failed to resolve",
    ),
    expected: undefined,
  },
  {
    name: "Deno 2.9: prose only",
    command: "deno",
    stdout: "",
    stderr: lines(
      "Download https://registry.npmjs.org/left-pad",
      "error: Could not find npm package 'left-pad' matching '99.99.99'.",
    ),
    expected: undefined,
  },
];

export function getPackageManagerOutputFixture(name: string): PackageManagerOutputFixture {
  const fixture = packageManagerOutputFixtures.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Unknown package manager output fixture: ${name}`);
  return fixture;
}
