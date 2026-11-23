import { execa } from "execa";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const YARN_VERSION = "4.18.1";

const directory = await mkdtemp(path.join(tmpdir(), "create-prisma-node-smoke-"));
const npmDirectory = path.join(directory, "npm");
const env = {
  DO_NOT_TRACK: "1",
  CREATE_PRISMA_DISABLE_TELEMETRY: "1",
  PRISMA_NEXT_DISABLE_TELEMETRY: "1",
  NO_UPDATE_NOTIFIER: "1",
  npm_config_engine_strict: "false",
};

async function scaffold(cli, parentDirectory, args, scaffoldEnv) {
  const created = await execa(
    process.execPath,
    [cli, "app", ...args, "--skills", "none", "--no-deploy", "--json"],
    { cwd: parentDirectory, env: scaffoldEnv },
  );
  if (!JSON.parse(created.stdout).ok) {
    throw new Error(`Packed CLI did not scaffold an app in ${parentDirectory}`);
  }
  return path.join(parentDirectory, "app");
}

// Yarn does not install peer dependencies, so this app catches a peer missing from the
// generated package.json. It is created outside the npm prefix, whose package.json Yarn
// would take as the app's project root.
async function smokeYarnMongoApp(cli) {
  const yarnDirectory = path.join(directory, "yarn");
  const corepackBin = path.join(yarnDirectory, "corepack-bin");
  await mkdir(corepackBin, { recursive: true });
  const yarnEnv = {
    ...env,
    COREPACK_HOME: path.join(yarnDirectory, "corepack-home"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    PATH: `${corepackBin}${path.delimiter}${process.env.PATH}`,
  };
  await execa("corepack", ["enable", "--install-directory", corepackBin, "yarn"], { env: yarnEnv });
  await execa("corepack", ["install", "--global", `yarn@${YARN_VERSION}`], { env: yarnEnv });
  const appDirectory = await scaffold(
    cli,
    yarnDirectory,
    [
      "--template",
      "minimal",
      "--provider",
      "mongo",
      "--authoring",
      "psl",
      "--package-manager",
      "yarn",
    ],
    yarnEnv,
  );
  const options = { cwd: appDirectory, env: yarnEnv, stdout: "inherit", stderr: "inherit" };
  await execa("yarn", ["run", "contract:emit"], options);
  await execa("yarn", ["run", "build"], options);
  await execa("yarn", ["exec", "tsc", "--noEmit"], options);
}

try {
  const packed = await execa("npm", [
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    directory,
    "--json",
  ]);
  const [{ filename }] = JSON.parse(packed.stdout);
  await execa(
    "npm",
    [
      "install",
      "--prefix",
      npmDirectory,
      path.join(directory, filename),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    {
      env: { ...env, npm_config_engine_strict: "true" },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const cli = path.join(npmDirectory, "node_modules/create-prisma/dist/cli.mjs");
  const appDirectory = await scaffold(
    cli,
    npmDirectory,
    [
      "--template",
      "minimal",
      "--provider",
      "postgres",
      "--authoring",
      "psl",
      "--package-manager",
      "npm",
    ],
    env,
  );
  const { stdout: npmVersion } = await execa("npm", ["--version"], { cwd: appDirectory });
  const { packageManager } = JSON.parse(
    await readFile(path.join(appDirectory, "package.json"), "utf8"),
  );
  if (packageManager !== `npm@${npmVersion}`) {
    throw new Error(`Generated packageManager is ${packageManager}, expected npm@${npmVersion}`);
  }
  const options = { cwd: appDirectory, env, stdout: "inherit", stderr: "inherit" };
  await execa("npm", ["run", "build"], options);
  await execa("npm", ["exec", "--", "tsc", "--noEmit"], options);
  await smokeYarnMongoApp(cli);
  console.log(
    `Packed CLI engine check, scaffold, npm install, build and typecheck passed on Node ${process.versions.node} with npm ${npmVersion}; a Yarn ${YARN_VERSION} MongoDB app installed, emitted its contract, built and typechecked.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
