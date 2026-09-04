import { Effect, Schema } from "effect";

import { CreateFailure } from "../../create-outcome";
import { PrismaWorkspaceSchema, type PrismaWorkspace } from "../../result";
import type { PackageManager } from "../../types";
import { decodePrismaCommandResult, runPrismaJsonCommandEffect } from "./prisma-cli";
import { getWorkspaceLabel } from "./workspace";

const ProjectShowResultSchema = Schema.Struct({
  workspace: PrismaWorkspaceSchema,
  project: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

const ProjectListResultSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
type ProjectListResult = typeof ProjectListResultSchema.Type;

const stripResourcePrefix = (id: string, prefix: "proj" | "wksp") =>
  id.startsWith(`${prefix}_`) ? id.slice(prefix.length + 1) : id;

export function getConsoleProjectUrl(workspaceId: string, projectId: string): string {
  return `https://console.prisma.io/${encodeURIComponent(stripResourcePrefix(workspaceId, "wksp"))}/${encodeURIComponent(stripResourcePrefix(projectId, "proj"))}`;
}

export function findProjectNameCollisions(
  projects: ProjectListResult["items"],
  appName: string,
): ProjectListResult["items"] {
  return projects.filter((project) => project.name === appName);
}

export const ensureProjectNameAvailable = Effect.fn("Deployment.ensureProjectNameAvailable")(
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
    const result = yield* decodePrismaCommandResult(ProjectListResultSchema, raw);
    const collisions = findProjectNameCollisions(result.items, options.appName);
    if (collisions.length === 0) return;
    const projectIds = collisions.map((project) => project.id).join(", ");
    return yield* new CreateFailure({
      stage: "check_project_name",
      reason: "project_name_collision",
      message: `A Prisma project named "${options.appName}" already exists in workspace ${getWorkspaceLabel(options.workspace)} (${options.workspace.id}). Choose a different project name or delete the existing project (${projectIds}) in Prisma Console, then retry.`,
    });
  },
);

export const getProjectDetails = Effect.fn("Deployment.getProjectDetails")(function* (options: {
  packageManager: PackageManager;
  projectDir: string;
  appName: string;
}) {
  return yield* Effect.gen(function* () {
    const raw = yield* runPrismaJsonCommandEffect({
      packageManager: options.packageManager,
      projectDir: options.projectDir,
      args: ["project", "show", options.appName],
    });
    const result = yield* decodePrismaCommandResult(ProjectShowResultSchema, raw);
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
});
