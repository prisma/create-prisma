import { cancel, isCancel, log, select } from "@clack/prompts";
import { Effect, Schema } from "effect";
import type { Writable } from "node:stream";

import { CreateCancellationError, CreateFailure } from "../../create-outcome";
import { PrismaWorkspaceSchema } from "../../result";
import { CommandRunner } from "../../services/command-runner";
import type { PackageManager } from "../../types";
import {
  getLocalPackageBinaryArgs,
  getLocalPackageBinaryCommand,
  getRunScriptCommand,
} from "../../utils/package-manager";
import { decodePrismaCommandResult, runPrismaJsonCommandEffect } from "./prisma-cli";
import { getWorkspaceLabel } from "./workspace";

const WhoamiResultSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  workspace: Schema.NullOr(PrismaWorkspaceSchema),
  source: Schema.NullOr(Schema.Literals(["stored", "environment"])),
});
export type WhoamiResult = typeof WhoamiResultSchema.Type;

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

export const ensureAuthentication = Effect.fn("Deployment.ensureAuthentication")(
  function* (options: {
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
      return yield* decodePrismaCommandResult(WhoamiResultSchema, raw);
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
    const login = getLocalPackageBinaryArgs(options.packageManager, "prisma", ["auth", "login"]);
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
  },
);

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
  return (yield* decodePrismaCommandResult(WorkspaceUseResultSchema, raw)).workspace;
});

export const selectDeploymentWorkspace = Effect.fn("Deployment.selectWorkspace")(
  function* (options: {
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
        if (
          options.workspace === activeWorkspace.id ||
          options.workspace === activeWorkspace.name
        ) {
          return activeWorkspace;
        }
        return yield* new CreateFailure({
          stage: "select_workspace",
          reason: "workspace_mismatch",
          message: `The environment credential is fixed to workspace ${getWorkspaceLabel(activeWorkspace)}. Unset it before using --workspace ${options.workspace}.`,
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
    const available = yield* decodePrismaCommandResult(WorkspaceListResultSchema, raw);
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
  },
);
