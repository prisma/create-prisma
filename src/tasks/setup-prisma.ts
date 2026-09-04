import { cancel, confirm, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import { Effect, FileSystem, Schema } from "effect";
import path from "node:path";
import type { Writable } from "node:stream";

import { PRISMA_DENO_CLI_PACKAGE, PRISMA_PLATFORM_CLI_PACKAGE } from "../constants/dependencies";
import {
  CreateCancellationError,
  CreateFailure,
  type CreateFailureReason,
  type CreateFailureStage,
} from "../create-outcome";
import type { ComposerDeployResult, CreateNextStep } from "../result";
import { applicationRuntime } from "../runtime";
import { scaffoldCreateSharedTemplatesEffect } from "../templates/render-create-template";
import {
  AuthoringStyleSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
  packageManagers,
  type AuthoringStyle,
  type CreateTemplate,
  type DatabaseProvider,
  type PackageManager,
  type PrismaSetupCommandInput,
} from "../types";
import { resolveExecutionSettings } from "../ui/output";
import { getErrorMessage } from "../utils/errors";
import {
  detectPackageManagerEffect,
  getInstallCommand,
  getPackageExecutionArgs,
  getRunScriptCommand,
} from "../utils/package-manager";
import { runSetupCommand } from "../utils/run-command";
import { deployNewProjectWithComposerEffect } from "./deploy-with-composer";
import { initializeGitRepositoryEffect, type GitInitializationResult } from "./initialize-git";
import { installProjectDependenciesEffect, writePrismaDependenciesEffect } from "./install";

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgres";
const DEFAULT_AUTHORING: AuthoringStyle = "psl";

type PrismaSetupRunOptions = {
  prependNextSteps?: CreateNextStep[];
  projectDir?: string;
  projectName?: string;
  template?: CreateTemplate;
  createdProjectPath?: string;
  includeDevNextStep?: boolean;
  initializeGit?: boolean;
  progressSpinner?: ReturnType<typeof spinner>;
};

export type PrismaSetupContext = {
  projectDir: string;
  verbose: boolean;
  json: boolean;
  output: Writable;
  databaseProvider: DatabaseProvider;
  authoring: AuthoringStyle;
  packageManager: PackageManager;
  shouldDeploy: boolean;
  shouldPromptForWorkspace: boolean;
  workspace?: string;
};

export type PrismaSetupSuccess = {
  deployment: ComposerDeployResult | null;
  nextSteps: CreateNextStep[];
  gitInitialization?: GitInitializationResult;
  warnings: string[];
};

const decodePromptValue = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new CreateFailure({
          stage: "collect_context",
          reason: "invalid_input",
          message: cause.message,
          cause,
        }),
    ),
  );

const promptForDatabaseProvider = Effect.fn("Prompts.databaseProvider")(function* (
  output: Writable,
) {
  const value = yield* Effect.tryPromise(() =>
    select({
      message: "Select your database",
      initialValue: DEFAULT_DATABASE_PROVIDER,
      options: [
        { value: "postgres", label: "PostgreSQL", hint: "Prisma Postgres with Composer" },
        { value: "mongo", label: "MongoDB", hint: "Connect an existing MongoDB database" },
      ],
      output,
    }),
  );
  if (isCancel(value)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output }));
    return yield* new CreateCancellationError({ stage: "database_provider" });
  }
  return yield* decodePromptValue(DatabaseProviderSchema, value);
});

const promptForAuthoringStyle = Effect.fn("Prompts.authoringStyle")(function* (output: Writable) {
  const value = yield* Effect.tryPromise(() =>
    select({
      message: "Choose contract authoring style",
      initialValue: DEFAULT_AUTHORING,
      options: [
        { value: "psl", label: "PSL", hint: "Prisma schema syntax" },
        { value: "typescript", label: "TypeScript", hint: "TypeScript contract builder" },
      ],
      output,
    }),
  );
  if (isCancel(value)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output }));
    return yield* new CreateCancellationError({ stage: "authoring_style" });
  }
  return yield* decodePromptValue(AuthoringStyleSchema, value);
});

const packageManagerHint = (option: PackageManager, detected: PackageManager) => {
  const hints = {
    npm: "Node.js default",
    pnpm: "Fast, disk-efficient package manager",
    yarn: "Yarn package manager",
    bun: "Fast runtime and package manager",
    deno: "Deno runtime (minimal PostgreSQL apps)",
  } satisfies Record<PackageManager, string>;
  return option === detected ? `Detected; ${hints[option]}` : hints[option];
};

const promptForPackageManager = Effect.fn("Prompts.packageManager")(function* (
  detected: PackageManager,
  output: Writable,
) {
  const value = yield* Effect.tryPromise(() =>
    select({
      message: "Choose package manager",
      initialValue: detected,
      options: packageManagers.map((packageManager) => ({
        value: packageManager,
        label: packageManager,
        hint: packageManagerHint(packageManager, detected),
      })),
      output,
    }),
  );
  if (isCancel(value)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output }));
    return yield* new CreateCancellationError({ stage: "package_manager" });
  }
  return yield* decodePromptValue(PackageManagerSchema, value);
});

const promptForDeployment = Effect.fn("Prompts.deployment")(function* (output: Writable) {
  const value = yield* Effect.tryPromise(() =>
    confirm({ message: "Deploy to Prisma now?", initialValue: true, output }),
  );
  if (isCancel(value)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output }));
    return yield* new CreateCancellationError({ stage: "deployment_intent" });
  }
  return Boolean(value);
});

export const collectPrismaSetupContextEffect = Effect.fn("PrismaSetup.collectContext")(function* (
  input: PrismaSetupCommandInput,
  options: { projectDir?: string; template?: CreateTemplate } = {},
) {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const { json, output, useDefaults } = resolveExecutionSettings(input);
  const databaseProvider =
    input.provider ??
    (useDefaults ? DEFAULT_DATABASE_PROVIDER : yield* promptForDatabaseProvider(output));
  const authoring =
    input.authoring ?? (useDefaults ? DEFAULT_AUTHORING : yield* promptForAuthoringStyle(output));
  const detectedPackageManager = yield* detectPackageManagerEffect(projectDir);
  const packageManager =
    input.packageManager ??
    (useDefaults
      ? detectedPackageManager
      : yield* promptForPackageManager(detectedPackageManager, output));

  if (packageManager === "deno" && databaseProvider !== "postgres") {
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "unsupported_configuration",
      message: "Deno support currently requires PostgreSQL.",
    });
  }
  if (packageManager === "deno" && options.template && options.template !== "minimal") {
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "unsupported_configuration",
      message: "Deno support currently requires the minimal template.",
    });
  }
  if (packageManager === "deno" && input.deploy === true) {
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "unsupported_configuration",
      message: "Prisma Compute does not support Deno deployments yet. Use --no-deploy.",
    });
  }

  const shouldDeploy =
    packageManager === "deno"
      ? false
      : (input.deploy ?? (json ? true : useDefaults ? false : yield* promptForDeployment(output)));
  return {
    projectDir,
    verbose: input.verbose === true,
    json,
    output,
    databaseProvider,
    authoring,
    packageManager,
    shouldDeploy,
    shouldPromptForWorkspace: !useDefaults,
    ...(input.workspace ? { workspace: input.workspace } : {}),
  } satisfies PrismaSetupContext;
});

const getContractPath = (authoring: AuthoringStyle) =>
  `src/prisma/contract${authoring === "typescript" ? ".ts" : ".prisma"}`;
const getInitTarget = (provider: DatabaseProvider) =>
  provider === "mongo" ? ("mongodb" as const) : ("postgres" as const);
const getPrismaCliInvocation = (packageManager: PackageManager, args: string[]) =>
  getPackageExecutionArgs(packageManager, [
    packageManager === "deno" ? PRISMA_DENO_CLI_PACKAGE : PRISMA_PLATFORM_CLI_PACKAGE,
    ...args,
  ]);

const runPrismaCli = Effect.fn("PrismaSetup.runCli")(function* (
  context: PrismaSetupContext,
  projectDir: string,
  args: string[],
) {
  const invocation = getPrismaCliInvocation(context.packageManager, args);
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

const runPrismaInit = Effect.fn("PrismaSetup.init")(function* (
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

const initializeAgentSkills = Effect.fn("PrismaSetup.initializeSkills")(function* (
  context: PrismaSetupContext,
  projectDir: string,
) {
  if (context.packageManager === "deno") return;
  yield* runPrismaCli(context, projectDir, ["init", "--yes", "--no-interactive"]);
});

const ensureGitignoreEntry = Effect.fn("PrismaSetup.ensureGitignoreEntry")(function* (
  projectDir: string,
  entry: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const gitignorePath = path.join(projectDir, ".gitignore");
  const existing = (yield* fs.exists(gitignorePath)) ? yield* fs.readFileString(gitignorePath) : "";
  const entries = existing.split(/\r?\n/).map((line) => line.trim());
  if (entries.includes(entry) || entries.includes(`/${entry}`)) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  yield* fs.writeFileString(gitignorePath, `${existing}${separator}${entry}\n`);
});

const ensureMongoEnvironment = Effect.fn("PrismaSetup.ensureMongoEnvironment")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const envPath = path.join(projectDir, ".env");
  if (!(yield* fs.exists(envPath))) {
    yield* fs.writeFileString(
      envPath,
      'DATABASE_URL="mongodb://localhost:27017/mydb?replicaSet=rs0&directConnection=true"\n',
    );
  }
  yield* ensureGitignoreEntry(projectDir, ".env");
});

const ensureComposerTypeScriptOptions = Effect.fn("PrismaSetup.ensureComposerTypeScriptOptions")(
  function* (projectDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const tsconfigPath = path.join(projectDir, "tsconfig.json");
    const tsconfig = yield* fs.readFileString(tsconfigPath);
    const additions: string[] = [];
    if (!/"allowImportingTsExtensions"\s*:/.test(tsconfig)) {
      additions.push('    "allowImportingTsExtensions": true,');
    }
    if (!/"noEmit"\s*:/.test(tsconfig)) additions.push('    "noEmit": true,');
    if (additions.length === 0) return;

    const updated = tsconfig.replace(
      /"compilerOptions"\s*:\s*\{/,
      (match) => `${match}\n${additions.join("\n")}`,
    );
    if (updated === tsconfig)
      return yield* Effect.fail(new Error("tsconfig.json is missing compilerOptions."));
    yield* fs.writeFileString(tsconfigPath, updated);
  },
);

const formatNextSteps = (steps: CreateNextStep[]) =>
  steps.map((step) => `${step.command}\n  ${step.description}`).join("\n\n");
const formatPlatformTarget = (name: string | null, id: string) => (name ? `${name} (${id})` : id);

function formatProjectSummary(options: {
  createdProjectPath?: string;
  deployment?: ComposerDeployResult;
}): string {
  const lines: string[] = [];
  if (options.createdProjectPath) lines.push(`Path: ${path.resolve(options.createdProjectPath)}`);
  if (options.deployment?.workspace) {
    lines.push(
      `Workspace: ${formatPlatformTarget(options.deployment.workspace.name, options.deployment.workspace.id)}`,
    );
  }
  if (options.deployment) {
    lines.push(
      `Project: ${
        options.deployment.project.id
          ? formatPlatformTarget(options.deployment.project.name, options.deployment.project.id)
          : options.deployment.project.name
      }`,
    );
    lines.push(`App: ${options.deployment.appUrl ?? options.deployment.appName}`);
    if (options.deployment.project.consoleUrl) {
      lines.push(`Console: ${options.deployment.project.consoleUrl}`);
    }
  }
  return lines.join("\n");
}

function buildNextSteps(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions,
): CreateNextStep[] {
  const nextSteps = [...(options.prependNextSteps ?? [])];
  if (context.databaseProvider === "mongo") {
    nextSteps.push({
      command: "Set MONGODB_URL in your environment",
      description: "Composer uses this secret when deploying the MongoDB template.",
    });
  }
  if (options.includeDevNextStep) {
    nextSteps.push({
      command: getRunScriptCommand(
        context.packageManager,
        context.packageManager === "deno" ? "dev" : "dev:composer",
      ),
      description:
        context.packageManager === "deno"
          ? "Start the Deno app after setting DATABASE_URL in .env."
          : "Build and start the app with Prisma Composer locally.",
    });
  }
  if (context.packageManager !== "deno") {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "deploy"),
      description: "Build and deploy the app with Prisma Composer.",
    });
  }
  return nextSteps;
}

const atStage = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  stage: CreateFailureStage,
  reason: CreateFailureReason,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof CreateFailure || error instanceof CreateCancellationError
        ? error
        : new CreateFailure({ stage, reason, message: getErrorMessage(error), cause: error }),
    ),
  );

export const executePrismaSetupContextEffect = Effect.fn("PrismaSetup.execute")(function* (
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
) {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const projectName = options.projectName ?? path.basename(projectDir);
  const template = options.template ?? "minimal";
  const progress = context.verbose
    ? undefined
    : (options.progressSpinner ?? spinner({ output: context.output }));
  const ownsProgress = progress !== undefined && !options.progressSpinner;
  let gitInitialization: GitInitializationResult | undefined;
  if (ownsProgress) yield* Effect.sync(() => progress.start("Creating Prisma 8 project..."));

  const setup = Effect.gen(function* () {
    yield* Effect.sync(() => progress?.message("Preparing Prisma 8 project files..."));
    yield* atStage(runPrismaInit(context, projectDir), "initialize_prisma", "prisma_init_failed");

    yield* atStage(
      Effect.gen(function* () {
        yield* scaffoldCreateSharedTemplatesEffect({
          projectDir,
          projectName,
          template,
          provider: context.databaseProvider,
          authoring: context.authoring,
          packageManager: context.packageManager,
        });
        yield* writePrismaDependenciesEffect(
          context.databaseProvider,
          context.packageManager,
          context.authoring,
          projectDir,
        );
        yield* ensureComposerTypeScriptOptions(projectDir);
        if (context.databaseProvider === "mongo") yield* ensureMongoEnvironment(projectDir);
        if (context.packageManager !== "deno") {
          yield* ensureGitignoreEntry(projectDir, "/.alchemy");
          yield* ensureGitignoreEntry(projectDir, "/.prisma-composer");
        }
      }),
      "configure_project",
      "project_configuration_failed",
    );

    yield* Effect.sync(() =>
      progress?.message(
        `Installing dependencies with ${getInstallCommand(context.packageManager)}...`,
      ),
    );
    yield* atStage(
      installProjectDependenciesEffect(context.packageManager, projectDir, {
        verbose: context.verbose,
        json: context.json,
      }),
      "install_dependencies",
      "dependency_install_failed",
    );

    yield* Effect.sync(() => progress?.message("Installing Prisma agent skills..."));
    yield* atStage(
      initializeAgentSkills(context, projectDir),
      "initialize_agent_skills",
      "agent_skills_init_failed",
    );

    yield* Effect.sync(() => progress?.message("Generating Prisma 8 contract artifacts..."));
    yield* atStage(
      runPrismaCli(context, projectDir, ["contract", "emit"]),
      "emit_contract",
      "contract_emit_failed",
    );

    if (context.databaseProvider === "postgres") {
      yield* Effect.sync(() => progress?.message("Authoring the baseline migration..."));
      yield* atStage(
        runPrismaCli(context, projectDir, ["migration", "plan", "--name", "init"]),
        "plan_migration",
        "migration_plan_failed",
      );
    }

    if (options.initializeGit) {
      yield* Effect.sync(() => progress?.message("Initializing Git repository..."));
      gitInitialization = yield* atStage(
        initializeGitRepositoryEffect(projectDir),
        "initialize_git",
        "git_initialization_failed",
      );
    }
  });

  yield* setup.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        progress?.stop("Prisma 8 project ready.");
        if (gitInitialization?.status === "initialized" && context.verbose) {
          log.success("Initialized Git repository with an initial commit.", {
            output: context.output,
          });
        } else if (gitInitialization?.status === "skipped") {
          log.warn(`Could not initialize Git repository: ${gitInitialization.reason}`, {
            output: context.output,
          });
        }
      }),
    ),
    Effect.tapError((error) =>
      Effect.sync(() => {
        progress?.error("Could not create Prisma 8 project.");
        if (!(error instanceof CreateCancellationError))
          cancel(getErrorMessage(error), { output: context.output });
      }),
    ),
    Effect.mapError((error) =>
      error instanceof CreateFailure
        ? new CreateFailure({
            stage: error.stage,
            reason: error.reason,
            message: error.message,
            cause: error.cause,
            errorReported: true,
          })
        : error,
    ),
  );

  const deployment = context.shouldDeploy
    ? yield* deployNewProjectWithComposerEffect({
        appName: projectName,
        packageManager: context.packageManager,
        projectDir,
        shouldPromptForWorkspace: context.shouldPromptForWorkspace,
        verbose: context.verbose,
        output: context.output,
        allowInteractiveLogin: !context.json,
        json: context.json,
        ...(context.workspace ? { workspace: context.workspace } : {}),
      })
    : null;

  const nextSteps = buildNextSteps(context, options);
  const warnings =
    gitInitialization?.status === "skipped"
      ? [`Could not initialize Git repository: ${gitInitialization.reason}`]
      : [];
  const projectSummary = formatProjectSummary({
    createdProjectPath: options.createdProjectPath,
    ...(deployment ? { deployment } : {}),
  });
  yield* Effect.sync(() => {
    if (projectSummary) {
      note(projectSummary, context.shouldDeploy ? "Deployment" : "Project", {
        output: context.output,
      });
    }
    note(formatNextSteps(nextSteps), "Next steps", { output: context.output });
    outro(context.shouldDeploy ? "Prisma 8 app deployed." : "Prisma 8 project ready.", {
      output: context.output,
    });
  });
  return {
    deployment,
    nextSteps,
    ...(gitInitialization ? { gitInitialization } : {}),
    warnings,
  } satisfies PrismaSetupSuccess;
});

export function collectPrismaSetupContext(
  input: PrismaSetupCommandInput,
  options: { projectDir?: string; template?: CreateTemplate } = {},
): Promise<PrismaSetupContext> {
  return applicationRuntime.runPromise(collectPrismaSetupContextEffect(input, options));
}

export function executePrismaSetupContext(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
): Promise<PrismaSetupSuccess> {
  return applicationRuntime.runPromise(executePrismaSetupContextEffect(context, options));
}
