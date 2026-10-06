import { log } from "@clack/prompts";
import { Effect, FileSystem } from "effect";
import path from "node:path";

import { getCreatePrismaSourceDir } from "../../templates/render-create-template";
import type {
  AuthoringStyle,
  CreateTemplate,
  DatabaseProvider,
  PrismaSetupCommandInput,
} from "../../types";
import { CreateCancellationError } from "../../create-outcome";
import { getLocalPackageBinaryArgs } from "../../utils/package-manager";
import { redactSecrets } from "../../utils/errors";
import { isPrismaCliCancellation, runPrismaJsonCommandEffect } from "../prisma-cli";
import type { PrismaSetupContext } from "./types";
import type { ExistingAppContext } from "../../commands/create-context";

const getContractPath = (authoring: AuthoringStyle, template: CreateTemplate) =>
  `${getCreatePrismaSourceDir(template)}/contract${authoring === "typescript" ? ".ts" : ".prisma"}`;

const getInitTarget = (provider: DatabaseProvider) =>
  provider === "mongo" ? ("mongodb" as const) : ("postgres" as const);

export const runExistingPrismaInit = Effect.fn("PrismaSetup.initExisting")(function* (
  context: ExistingAppContext,
  input: PrismaSetupCommandInput,
) {
  return yield* runPrismaJsonCommandEffect({
    packageManager: context.packageManager,
    projectDir: context.targetDirectory,
    cliPackage: "prisma@latest",
    args: [
      "orm",
      "init",
      ...(input.provider ? ["--target", getInitTarget(input.provider)] : []),
      ...(input.authoring ? ["--authoring", input.authoring] : []),
    ],
    interactive: true,
  }).pipe(
    Effect.mapError((error) =>
      isPrismaCliCancellation(error)
        ? new CreateCancellationError({ stage: "initialize_prisma" })
        : error,
    ),
  );
});

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
  yield* runPrismaJsonCommandEffect({
    packageManager: context.packageManager,
    projectDir,
    args,
    env: { ...process.env, CI: "1" },
    ...(context.verbose
      ? {
          onStderrLine: (line: string) =>
            log.message(redactSecrets(line), { output: context.output }),
        }
      : {}),
  });
});

export const runPrismaInit = Effect.fn("PrismaSetup.init")(function* (
  context: PrismaSetupContext,
  projectDir: string,
  force = false,
  template: CreateTemplate = "minimal",
) {
  yield* runPrismaCli(context, projectDir, [
    "orm",
    "init",
    "--yes",
    ...(force ? ["--confirm", path.basename(projectDir).trim() || projectDir.trim()] : []),
    "--target",
    getInitTarget(context.databaseProvider),
    "--authoring",
    context.authoring,
    "--schema-path",
    getContractPath(context.authoring, template),
    "--skip-install",
  ]);
  if (context.packageManager === "deno") {
    const fs = yield* FileSystem.FileSystem;
    for (const primer of ["prisma-8.md", "prisma-next.md"]) {
      yield* fs.remove(path.join(projectDir, primer), { force: true });
    }
  }
});

export const initializeAgentSkills = Effect.fn("PrismaSetup.initializeSkills")(function* (
  context: PrismaSetupContext,
  projectDir: string,
) {
  if (context.skillAgents.length === 0) return;
  yield* runPrismaCli(context, projectDir, [
    "init",
    "--yes",
    `--skills=${context.skillAgents.join(",")}`,
  ]);
});
