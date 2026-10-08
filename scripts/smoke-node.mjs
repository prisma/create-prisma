import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "create-prisma-node-smoke-"));
const env = {
  DO_NOT_TRACK: "1",
  CREATE_PRISMA_DISABLE_TELEMETRY: "1",
  PRISMA_NEXT_DISABLE_TELEMETRY: "1",
  NO_UPDATE_NOTIFIER: "1",
  npm_config_engine_strict: "false",
};

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
      directory,
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
  const created = await execa(
    process.execPath,
    [
      path.join(directory, "node_modules/create-prisma/dist/cli.mjs"),
      "app",
      "--template",
      "minimal",
      "--provider",
      "postgres",
      "--authoring",
      "psl",
      "--package-manager",
      "npm",
      "--skills",
      "none",
      "--no-deploy",
      "--json",
    ],
    { cwd: directory, env },
  );
  if (!JSON.parse(created.stdout).ok) throw new Error("Packed CLI did not scaffold successfully");
  const options = { cwd: path.join(directory, "app"), env, stdout: "inherit", stderr: "inherit" };
  await execa("npm", ["run", "build"], options);
  await execa("npm", ["exec", "--", "tsc", "--noEmit"], options);
  console.log(
    `Packed CLI engine check, scaffold, build and typecheck passed on Node ${process.versions.node}.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
