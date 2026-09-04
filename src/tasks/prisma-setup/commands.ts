import { log } from "@clack/prompts";
import { Effect, FileSystem } from "effect";
import path from "node:path";

import type { AuthoringStyle, DatabaseProvider } from "../../types";
import { getLocalPackageBinaryArgs } from "../../utils/package-manager";
import { runSetupCommand } from "../../utils/run-command";
import type { PrismaSetupContext } from "./types";

const getContractPath = (authoring: AuthoringStyle) =>
  `src/prisma/contract${authoring === "typescript" ? ".ts" : ".prisma"}`;

const getInitTarget = (provider: DatabaseProvider) =>
  provider === "mongo" ? ("mongodb" as const) : ("postgres" as const);

export const runPrismaCli = Effect.fn("PrismaSetup.runCli")(function* (
  context: PrismaSetupContext,
  projectDir: string,
  args: string[],
) {
  const invocation = getLocalPackageBinaryArgs(context.packageManager, "prisma", args);
  yield* Effect.sync(() => {
    if (context.verbose) {
      log.step([invocation.command, ...invocation.args].join(" "), { output: context.output });
    }
  });
  yield* runSetupCommand({
    command: invocation.command,
    args: invocation.args,
    cwd: projectDir,
    env: { ...process.env, CI: "1" },
    verbose: context.verbose,
    json: context.json,
  });
});

export const runPrismaInit = Effect.fn("PrismaSetup.init")(function* (
  context: PrismaSetupContext,
  projectDir: string,
) {
  yield* runPrismaCli(context, projectDir, [
    "orm",
    "init",
    "--yes",
    "--no-interactive",
    "--target",
    getInitTarget(context.databaseProvider),
    "--authoring",
    context.authoring,
    "--schema-path",
    getContractPath(context.authoring),
    "--skip-install",
  ]);
  if (context.packageManager === "deno") {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path.join(projectDir, "prisma-next.md"), { force: true });
  }
});

export const initializeAgentSkills = Effect.fn("PrismaSetup.initializeSkills")(function* (
  context: PrismaSetupContext,
  projectDir: string,
) {
  if (context.packageManager === "deno") return;
  yield* runPrismaCli(context, projectDir, ["init", "--yes", "--no-interactive"]);
});
