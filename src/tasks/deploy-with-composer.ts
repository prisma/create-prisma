import { cancel, isCancel, log, select, spinner, taskLog } from "@clack/prompts";
import { Cause, Effect, Exit, Schema } from "effect";
import type { Writable } from "node:stream";

import {
  CreateCancellationError,
  CreateFailure,
  PrismaCliCommandError,
  type CreateFailureReason,
  type CreateFailureStage,
} from "../create-outcome";
import { type ComposerDeployResult, PrismaWorkspaceSchema, type PrismaWorkspace } from "../result";
import { applicationRuntime } from "../runtime";
import { CommandRunner } from "../services/command-runner";
import type { PackageManager } from "../types";
import { getErrorMessage, redactSecrets } from "../utils/errors";
import {
  getLocalPackageBinaryArgs,
  getLocalPackageBinaryCommand,
  getRunScriptArgs,
  getRunScriptCommand,
} from "../utils/package-manager";
import { runSetupCommand } from "../utils/run-command";

const PrismaCliEnvelopeSchema = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.optionalKey(Schema.String),
  commandId: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      summary: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      why: Schema.optionalKey(Schema.String),
    }),
  ),
});
type PrismaCliEnvelope = typeof PrismaCliEnvelopeSchema.Type;
const decodePrismaCliEnvelope = Schema.decodeUnknownExit(PrismaCliEnvelopeSchema);

const WhoamiResultSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  workspace: Schema.NullOr(PrismaWorkspaceSchema),
  source: Schema.NullOr(Schema.Literals(["stored", "environment"])),
});
type WhoamiResult = typeof WhoamiResultSchema.Type;

const WorkspaceListResultSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      workspaceId: Schema.String,
      workspaceName: Schema.NullOr(Schema.String),
      current: Schema.Boolean,
    }),
  ),
});

const WorkspaceUseResultSchema = Schema.Struct({ workspace: PrismaWorkspaceSchema });

const ProjectShowResultSchema = Schema.Struct({
  workspace: PrismaWorkspaceSchema,
  project: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

const ProjectListResultSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
type ProjectListResult = typeof ProjectListResultSchema.Type;

const ComposerDeployCommandResultSchema = Schema.Struct({
  summary: Schema.NullOr(
    Schema.Struct({
      app: Schema.String,
      nodes: Schema.Array(
        Schema.Struct({
          entities: Schema.Array(
            Schema.Struct({
              kind: Schema.String,
              id: Schema.String,
              url: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
});
type ComposerDeployCommandResult = typeof ComposerDeployCommandResultSchema.Type;

export type ComposerDeployExecutionResult =
  | { ok: true; deployment: ComposerDeployResult }
  | { ok: false; cancelled: true; stage: "select_workspace" }
  | {
      ok: false;
      cancelled?: false;
      stage: CreateFailureStage;
      reason: CreateFailureReason;
      error: unknown;
    };

const stripResourcePrefix = (id: string, prefix: "proj" | "wksp") =>
  id.startsWith(`${prefix}_`) ? id.slice(prefix.length + 1) : id;

export function getConsoleProjectUrl(workspaceId: string, projectId: string): string {
  return `https://console.prisma.io/${encodeURIComponent(stripResourcePrefix(workspaceId, "wksp"))}/${encodeURIComponent(stripResourcePrefix(projectId, "proj"))}`;
}

export function parsePrismaCliEnvelope(output: string): PrismaCliEnvelope {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const candidate = parsed.kind === "result" ? parsed.envelope : parsed;
      const decoded = decodePrismaCliEnvelope(candidate);
      if (decoded._tag === "Success") return decoded.value;
    } catch {
      // Prisma may emit progress frames before the terminal JSON envelope.
    }
  }
  throw new Error("Prisma CLI returned output that is not a valid result envelope.");
}

const getPrismaCliArgs = (packageManager: PackageManager, args: string[]) =>
  getLocalPackageBinaryArgs(packageManager, "prisma", args);

const runPrismaJsonCommandEffect = Effect.fn("PrismaCli.runJson")(function* (options: {
  packageManager: PackageManager;
  projectDir: string;
  args: string[];
  onStderrLine?: (line: string) => void;
}) {
  const runner = yield* CommandRunner;
  const invocation = getPrismaCliArgs(options.packageManager, [
    ...options.args,
    "--json",
    "--no-interactive",
  ]);
  const result = yield* runner.run({
    command: invocation.command,
    args: invocation.args,
    cwd: options.projectDir,
    env: process.env,
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
  });

  let envelope: PrismaCliEnvelope;
  try {
    envelope = parsePrismaCliEnvelope(result.stdout);
  } catch (cause) {
    return yield* new PrismaCliCommandError({
      message: result.stderr.trim() || getErrorMessage(cause),
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  if (result.exitCode !== 0 || !envelope.ok || envelope.result === undefined) {
    const summary = envelope.error?.summary ?? envelope.error?.message;
    return yield* new PrismaCliCommandError({
      message:
        [summary, envelope.error?.why].filter(Boolean).join(": ") ||
        result.stderr.trim() ||
        "Prisma CLI command failed.",
      ...(envelope.commandId || envelope.command
        ? { command: envelope.commandId ?? envelope.command }
        : {}),
      ...(envelope.error?.code ? { code: envelope.error.code } : {}),
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return envelope.result;
});

const decodeCommandResult = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new PrismaCliCommandError({
          message: `Prisma CLI returned an invalid result: ${cause.message}`,
        }),
    ),
  );

export function findProjectNameCollisions(
  projects: ProjectListResult["items"],
  appName: string,
): ProjectListResult["items"] {
  return projects.filter((project) => project.name === appName);
}

const workspaceLabel = (workspace: PrismaWorkspace) => workspace.name ?? workspace.id;

const ensureProjectNameAvailable = Effect.fn("Deployment.ensureProjectNameAvailable")(
  function* (options: {
    appName: string;
    packageManager: PackageManager;
    projectDir: string;
    workspace: PrismaWorkspace;
  }) {
    const raw = yield* runPrismaJsonCommandEffect({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      args: ["project", "list"],
    });
    const result = yield* decodeCommandResult(ProjectListResultSchema, raw);
    const collisions = findProjectNameCollisions(result.items, options.appName);
    if (collisions.length === 0) return;
    const projectIds = collisions.map((project) => project.id).join(", ");
    return yield* new CreateFailure({
      stage: "check_project_name",
      reason: "project_name_collision",
      message: `A Prisma project named "${options.appName}" already exists in workspace ${workspaceLabel(options.workspace)} (${options.workspace.id}). Choose a different project name or delete the existing project (${projectIds}) in Prisma Console, then retry.`,
    });
  },
);

const ensureAuthentication = Effect.fn("Deployment.ensureAuthentication")(function* (options: {
  packageManager: PackageManager;
  projectDir: string;
  output: Writable;
  allowInteractiveLogin: boolean;
  beforeInteractiveLogin?: () => void;
}) {
  const whoami = Effect.fn("PrismaCli.whoami")(function* () {
    const raw = yield* runPrismaJsonCommandEffect({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      args: ["auth", "whoami"],
    });
    return yield* decodeCommandResult(WhoamiResultSchema, raw);
  });

  const authState = yield* whoami();
  if (authState.authenticated) return authState;
  const loginCommand = getLocalPackageBinaryCommand(options.packageManager, "prisma", [
    "auth",
    "login",
  ]);
  if (!options.allowInteractiveLogin || process.stdin.isTTY !== true) {
    return yield* new CreateFailure({
      stage: "authenticate",
      reason: "not_authenticated",
      message: `Sign in first with ${loginCommand}, then run ${getRunScriptCommand(options.packageManager, "deploy")}.`,
    });
  }

  yield* Effect.sync(() => {
    options.beforeInteractiveLogin?.();
    log.info("Sign in to Prisma to deploy.", { output: options.output });
  });
  const runner = yield* CommandRunner;
  const login = getPrismaCliArgs(options.packageManager, ["auth", "login"]);
  yield* runner.runChecked({
    command: login.command,
    args: login.args,
    cwd: options.projectDir,
    env: process.env,
    stdio: "inherit",
  });

  const authenticatedState = yield* whoami();
  if (!authenticatedState.authenticated) {
    return yield* new CreateFailure({
      stage: "authenticate",
      reason: "authentication_failed",
      message: "Prisma sign-in completed without an active workspace session.",
    });
  }
  return authenticatedState;
});

const useWorkspace = Effect.fn("Deployment.useWorkspace")(function* (options: {
  packageManager: PackageManager;
  projectDir: string;
  workspace: string;
}) {
  const raw = yield* runPrismaJsonCommandEffect({
    packageManager: options.packageManager,
    projectDir: options.projectDir,
    args: ["auth", "workspace", "use", options.workspace],
  });
  return (yield* decodeCommandResult(WorkspaceUseResultSchema, raw)).workspace;
});

const selectDeploymentWorkspace = Effect.fn("Deployment.selectWorkspace")(function* (options: {
  packageManager: PackageManager;
  projectDir: string;
  shouldPrompt: boolean;
  workspace?: string;
  authState: WhoamiResult;
  beforePrompt?: () => void;
  afterPrompt?: () => void;
  output: Writable;
}) {
  const activeWorkspace = options.authState.workspace;
  if (!activeWorkspace) {
    return yield* new CreateFailure({
      stage: "select_workspace",
      reason: "workspace_missing",
      message: "The active Prisma credential does not specify a workspace.",
    });
  }

  if (options.workspace) {
    if (options.authState.source === "environment") {
      if (options.workspace === activeWorkspace.id || options.workspace === activeWorkspace.name) {
        return activeWorkspace;
      }
      return yield* new CreateFailure({
        stage: "select_workspace",
        reason: "workspace_mismatch",
        message: `The environment credential is fixed to workspace ${workspaceLabel(activeWorkspace)}. Unset it before using --workspace ${options.workspace}.`,
      });
    }
    return yield* useWorkspace({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      workspace: options.workspace,
    });
  }

  if (!options.shouldPrompt || process.stdin.isTTY !== true) return activeWorkspace;
  const raw = yield* runPrismaJsonCommandEffect({
    packageManager: options.packageManager,
    projectDir: options.projectDir,
    args: ["auth", "workspace", "list"],
  });
  const available = yield* decodeCommandResult(WorkspaceListResultSchema, raw);
  if (available.items.length <= 1) return activeWorkspace;

  yield* Effect.sync(() => options.beforePrompt?.());
  const selectedWorkspaceId = yield* Effect.tryPromise(() =>
    select({
      message: "Select Prisma workspace for deployment",
      initialValue: activeWorkspace.id,
      options: available.items.map((workspace) => ({
        value: workspace.workspaceId,
        label: workspace.workspaceName ?? workspace.workspaceId,
        hint: workspace.current ? `${workspace.workspaceId}, current` : workspace.workspaceId,
      })),
      output: options.output,
    }),
  );
  if (isCancel(selectedWorkspaceId)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output: options.output }));
    return yield* new CreateCancellationError({ stage: "select_workspace" });
  }
  yield* Effect.sync(() => options.afterPrompt?.());
  if (selectedWorkspaceId === activeWorkspace.id) return activeWorkspace;
  return yield* useWorkspace({
    packageManager: options.packageManager,
    projectDir: options.projectDir,
    workspace: selectedWorkspaceId,
  });
});

export function parseComposerDeployResult(
  result: ComposerDeployCommandResult,
): { appName: string; appUrl?: string; serviceId?: string } | undefined {
  if (!result.summary) return;
  const computeService = result.summary.nodes
    .flatMap((node) => node.entities)
    .find((entity) => entity.kind === "compute-service");
  return {
    appName: result.summary.app,
    ...(computeService?.id ? { serviceId: computeService.id } : {}),
    ...(computeService?.url ? { appUrl: computeService.url.replace(/\/$/, "") } : {}),
  };
}

const getProjectDetails = Effect.fn("Deployment.getProjectDetails")(function* (options: {
  packageManager: PackageManager;
  projectDir: string;
  appName: string;
}) {
  const details = yield* Effect.gen(function* () {
    const raw = yield* runPrismaJsonCommandEffect({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      args: ["project", "show", options.appName],
    });
    const result = yield* decodeCommandResult(ProjectShowResultSchema, raw);
    if (!result.project) return undefined;
    return {
      workspace: result.workspace,
      project: {
        id: result.project.id,
        name: result.project.name,
        consoleUrl: getConsoleProjectUrl(result.workspace.id, result.project.id),
      },
    };
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  return details;
});

type DeployOptions = {
  appName: string;
  packageManager: PackageManager;
  projectDir: string;
  shouldPromptForWorkspace: boolean;
  verbose: boolean;
  output?: Writable;
  allowInteractiveLogin?: boolean;
  json?: boolean;
  workspace?: string;
};

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

export const deployNewProjectWithComposerEffect = Effect.fn("Deployment.deploy")(function* (
  options: DeployOptions,
) {
  const output = options.output ?? process.stdout;
  const progress = options.verbose ? undefined : spinner({ output });
  let deploymentLog: ReturnType<typeof taskLog> | undefined;
  let progressRunning = false;
  const showProgress = (message: string) => {
    if (!progress) return;
    if (progressRunning) progress.message(message);
    else {
      progress.start(message);
      progressRunning = true;
    }
  };
  const clearProgress = () => {
    if (!progress || !progressRunning) return;
    progress.clear();
    progressRunning = false;
  };

  const program = Effect.gen(function* () {
    yield* Effect.sync(() => {
      showProgress("Checking Prisma account...");
      if (options.verbose) log.step("Checking Prisma account.", { output });
    });
    const authState = yield* atStage(
      ensureAuthentication({
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        output,
        allowInteractiveLogin: options.allowInteractiveLogin ?? true,
        beforeInteractiveLogin: clearProgress,
      }),
      "authenticate",
      "prisma_auth_command_failed",
    );

    yield* Effect.sync(() => {
      showProgress("Checking Prisma workspace...");
      if (options.verbose) log.step("Checking Prisma workspace.", { output });
    });
    const selectedWorkspace = yield* atStage(
      selectDeploymentWorkspace({
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        shouldPrompt: options.shouldPromptForWorkspace,
        authState,
        output,
        beforePrompt: clearProgress,
        afterPrompt: () => showProgress("Selecting Prisma workspace..."),
        ...(options.workspace ? { workspace: options.workspace } : {}),
      }),
      "select_workspace",
      "workspace_selection_failed",
    );

    yield* Effect.sync(() => {
      showProgress("Checking Prisma project name...");
      if (options.verbose) log.step("Checking Prisma project name.", { output });
    });
    yield* atStage(
      ensureProjectNameAvailable({
        appName: options.appName,
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        workspace: selectedWorkspace,
      }),
      "check_project_name",
      "project_lookup_failed",
    );

    yield* Effect.sync(() => {
      showProgress("Building for deployment...");
      if (options.verbose) log.step("Building for deployment.", { output });
    });
    const build = getRunScriptArgs(options.packageManager, "build");
    yield* atStage(
      runSetupCommand({
        command: build.command,
        args: build.args,
        cwd: options.projectDir,
        env: process.env,
        verbose: options.verbose,
        json: options.json === true,
      }),
      "build",
      "build_failed",
    );

    const deployCommand = getLocalPackageBinaryCommand(options.packageManager, "prisma", [
      "deploy",
      "module.ts",
    ]);
    yield* Effect.sync(() => {
      clearProgress();
      if (options.verbose) log.step(`Deploying to Prisma with ${deployCommand}.`, { output });
      else {
        deploymentLog = taskLog({ title: "Deploying to Prisma...", limit: 10, output });
        deploymentLog.message(`$ ${deployCommand}`);
      }
    });
    const rawDeployment = yield* atStage(
      runPrismaJsonCommandEffect({
        packageManager: options.packageManager,
        projectDir: options.projectDir,
        args: ["deploy", "module.ts"],
        onStderrLine: (line) => {
          const redacted = redactSecrets(line);
          if (options.verbose) output.write(`${redacted}\n`);
          else deploymentLog?.message(redacted);
        },
      }),
      "composer_deploy",
      "composer_deploy_failed",
    );
    const deploymentResult = yield* atStage(
      decodeCommandResult(ComposerDeployCommandResultSchema, rawDeployment),
      "composer_deploy",
      "composer_deploy_failed",
    );
    const deployment = parseComposerDeployResult(deploymentResult);
    const appName = deployment?.appName ?? options.appName;

    yield* Effect.sync(() => {
      if (options.verbose) log.step("Loading deployment details.", { output });
      else deploymentLog?.message("Loading deployment details...");
    });
    const details = yield* getProjectDetails({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      appName,
    });
    yield* Effect.sync(() => {
      deploymentLog?.success("Deployed to Prisma.");
      deploymentLog = undefined;
      progressRunning = false;
      if (options.verbose) log.success("Deployed to Prisma.", { output });
    });

    return {
      appName,
      ...(deployment?.appUrl ? { appUrl: deployment.appUrl } : {}),
      ...(deployment?.serviceId ? { serviceId: deployment.serviceId } : {}),
      workspace: details?.workspace ?? selectedWorkspace,
      project: details?.project ?? { name: appName },
    } satisfies ComposerDeployResult;
  });

  return yield* program.pipe(
    Effect.tapCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause);
        if (deploymentLog) {
          deploymentLog.error("Deployment failed.");
          deploymentLog = undefined;
        } else {
          progress?.error("Deployment failed.");
        }
        progressRunning = false;
        if (!(error instanceof CreateCancellationError)) {
          log.error(`Deploy failed: ${getErrorMessage(error)}`, { output });
        }
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
});

export async function deployNewProjectWithComposer(
  options: DeployOptions,
): Promise<ComposerDeployExecutionResult> {
  const exit = await applicationRuntime.runPromiseExit(deployNewProjectWithComposerEffect(options));
  if (Exit.isSuccess(exit)) {
    return {
      ok: true,
      deployment: exit.value,
    };
  }

  const failureReason = exit.cause.reasons.find(Cause.isFailReason);
  const error = failureReason?.error ?? Cause.squash(exit.cause);
  if (error instanceof CreateCancellationError) {
    return { ok: false, cancelled: true, stage: "select_workspace" };
  }
  const failure =
    error instanceof CreateFailure
      ? error
      : new CreateFailure({
          stage: "unknown",
          reason: "unexpected_error",
          message: getErrorMessage(error),
          cause: error,
        });
  return {
    ok: false,
    stage: failure.stage,
    reason: failure.reason,
    error: failure.cause ?? failure,
  };
}

export { PrismaCliCommandError };
export type { ComposerDeployResult } from "../result";
