import { cancel, isCancel, log, select, text } from "@clack/prompts";
import { Effect, FileSystem, Schema } from "effect";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  CreateCancellationError,
  CreateFailure,
  type CreateTargetDirectoryKind,
} from "../create-outcome";
import type { CreateProjectResult } from "../result";
import { collectPrismaSetupContextEffect, type PrismaSetupContext } from "../tasks/setup-prisma";
import {
  CreateTemplateSchema,
  type CreateCommandInput,
  type CreateTemplate,
  type DatabaseProvider,
} from "../types";
import { resolveExecutionSettings } from "../ui/output";
import { detectPackageManagerEffect, getPackageExecutionCommand } from "../utils/package-manager";

const DEFAULT_PROJECT_NAME = "my-app";
const DEFAULT_TEMPLATE: CreateTemplate = "minimal";
const EXISTING_PROJECT_DOCS_URL = {
  postgres: "https://www.prisma.io/docs/prisma-orm/add-to-existing-project/postgresql",
  mongo: "https://www.prisma.io/docs/prisma-orm/add-to-existing-project/mongodb",
} satisfies Record<DatabaseProvider, string>;

export type CreateTargetPathState = {
  exists: boolean;
  isDirectory: boolean;
  isEmptyDirectory: boolean;
};

export type CreatePromptContext = {
  targetDirectory: string;
  targetPathState: CreateTargetPathState;
  force: boolean;
  template: CreateTemplate;
  projectPackageName: string;
  prismaSetupContext: PrismaSetupContext;
};

const toPackageName = (projectName: string) =>
  projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "") || "app";

export const formatPathForDisplay = (filePath: string) =>
  path.relative(process.cwd(), filePath) || ".";

function validateProjectName(value: string | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length === 0) return "Please enter a project name.";
  if (trimmed === "..") return "Project name cannot be '..'.";
  if (path.isAbsolute(trimmed)) return "Use a relative project name instead of an absolute path.";
}

export const createProjectResult = (context: CreatePromptContext): CreateProjectResult => ({
  name: context.projectPackageName,
  path: context.targetDirectory,
  template: context.template,
  databaseProvider: context.prismaSetupContext.databaseProvider,
  authoring: context.prismaSetupContext.authoring,
  packageManager: context.prismaSetupContext.packageManager,
});

const promptForProjectName = Effect.fn("Prompts.projectName")(function* (
  output: Writable,
  options: { prefill: boolean } = { prefill: true },
) {
  const value = yield* Effect.tryPromise(() =>
    text({
      message: "Project name",
      placeholder: DEFAULT_PROJECT_NAME,
      ...(options.prefill ? { initialValue: DEFAULT_PROJECT_NAME } : {}),
      validate: validateProjectName,
      output,
    }),
  );
  if (isCancel(value)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output }));
    return yield* new CreateCancellationError({ stage: "project_name" });
  }
  return String(value).trim();
});

const promptForCreateTemplate = Effect.fn("Prompts.template")(function* (output: Writable) {
  const value = yield* Effect.tryPromise(() =>
    select({
      message: "Select template",
      initialValue: DEFAULT_TEMPLATE,
      options: [
        {
          value: "minimal",
          label: "Minimal",
          hint: "Script-first Prisma 8 starter with no web framework",
        },
        { value: "hono", label: "Hono", hint: "Lightweight TypeScript API server" },
        { value: "elysia", label: "Elysia", hint: "Bun-friendly TypeScript API server" },
        {
          value: "nest",
          label: "NestJS",
          hint: "Structured Node API with controllers and services",
        },
        { value: "next", label: "Next.js", hint: "Full-stack React app with App Router" },
        {
          value: "turborepo",
          label: "Monorepo (Turborepo)",
          hint: "Hello World server with a shared Prisma database package",
        },
        { value: "svelte", label: "SvelteKit", hint: "Full-stack Svelte 5 app with Vite" },
        { value: "astro", label: "Astro", hint: "Content-oriented web app with server routes" },
        { value: "nuxt", label: "Nuxt", hint: "Full-stack Vue app with Nitro server routes" },
        {
          value: "tanstack-start",
          label: "TanStack Start",
          hint: "React app with file routes and server functions",
        },
      ],
      output,
    }),
  );
  if (isCancel(value)) {
    yield* Effect.sync(() => cancel("Operation cancelled.", { output }));
    return yield* new CreateCancellationError({ stage: "template" });
  }
  return yield* Schema.decodeUnknownEffect(CreateTemplateSchema)(value).pipe(
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
});

const inspectTargetPath = Effect.fn("Create.inspectTargetPath")(function* (targetPath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(targetPath))) {
    return { exists: false, isDirectory: true, isEmptyDirectory: true };
  }
  const stats = yield* fs.stat(targetPath);
  if (stats.type !== "Directory") {
    return { exists: true, isDirectory: false, isEmptyDirectory: false };
  }
  return {
    exists: true,
    isDirectory: true,
    isEmptyDirectory: (yield* fs.readDirectory(targetPath)).length === 0,
  };
});

const inspectTargetDirectoryKind = Effect.fn("Create.inspectTargetDirectoryKind")(function* (
  targetDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(path.join(targetDirectory, "prisma.config.ts"))) {
    return "prisma_project" satisfies CreateTargetDirectoryKind;
  }
  if (yield* fs.exists(path.join(targetDirectory, "package.json"))) {
    return "existing_app" satisfies CreateTargetDirectoryKind;
  }
  return "other" satisfies CreateTargetDirectoryKind;
});

const describeNonEmptyTarget = Effect.fn("Create.describeNonEmptyTarget")(function* (
  targetDirectory: string,
  kind: CreateTargetDirectoryKind,
  provider: DatabaseProvider | undefined,
) {
  const displayPath = formatPathForDisplay(targetDirectory);
  switch (kind) {
    case "existing_app": {
      const initCommand = getPackageExecutionCommand(
        yield* detectPackageManagerEffect(targetDirectory),
        ["prisma@latest", "orm", "init"],
      );
      const docsUrl = provider
        ? EXISTING_PROJECT_DOCS_URL[provider]
        : "https://www.prisma.io/docs/cli/orm-init";
      return `Target directory ${displayPath} already contains an app. Run \`${initCommand}\` there to add Prisma (${docsUrl}), or choose a different name for a new app. --force overwrites starter and Prisma files.`;
    }
    case "prisma_project":
      return `Target directory ${displayPath} already contains a Prisma project. Use the Prisma CLI, or choose a different name. To resume an interrupted scaffold, rerun with --force; it overwrites starter and Prisma files.`;
    case "other":
      return `Target directory ${displayPath} is not empty. Choose a different project name. --force overwrites starter and Prisma files.`;
  }
});

type CreateTarget = { targetDirectory: string; targetPathState: CreateTargetPathState };

const resolveCreateTarget = Effect.fn("Create.resolveTarget")(function* (
  projectName: string,
  options: { force: boolean; provider: DatabaseProvider | undefined },
) {
  const validationError = validateProjectName(projectName);
  if (validationError) {
    return new CreateFailure({
      stage: "collect_context",
      reason: "invalid_project_name",
      message: validationError,
      errorReported: true,
    });
  }

  const targetDirectory = path.resolve(process.cwd(), projectName);
  const targetPathState = yield* inspectTargetPath(targetDirectory);
  if (targetPathState.exists && !targetPathState.isDirectory) {
    return new CreateFailure({
      stage: "collect_context",
      reason: "target_path_not_directory",
      message: `Target path ${formatPathForDisplay(targetDirectory)} already exists and is not a directory. Choose a different project name.`,
      errorReported: true,
    });
  }
  if (targetPathState.exists && !targetPathState.isEmptyDirectory && !options.force) {
    const kind = yield* inspectTargetDirectoryKind(targetDirectory);
    return new CreateFailure({
      stage: "collect_context",
      reason: "target_directory_not_empty",
      message: yield* describeNonEmptyTarget(targetDirectory, kind, options.provider),
      errorReported: true,
      targetDirectoryKind: kind,
    });
  }
  return { targetDirectory, targetPathState } satisfies CreateTarget;
});

export const collectCreateContext = Effect.fn("Create.collectContext")(function* (
  input: CreateCommandInput,
) {
  const force = input.force === true;
  const { output, useDefaults } = resolveExecutionSettings(input);
  const namePrompted = input.name === undefined && !useDefaults;
  const targetOptions = { force, provider: input.provider };
  let target = yield* resolveCreateTarget(
    String(
      input.name ?? (useDefaults ? DEFAULT_PROJECT_NAME : yield* promptForProjectName(output)),
    ).trim(),
    targetOptions,
  );
  while (target instanceof CreateFailure && namePrompted) {
    const { message } = target;
    yield* Effect.sync(() => log.warn(message, { output }));
    target = yield* resolveCreateTarget(
      yield* promptForProjectName(output, { prefill: false }),
      targetOptions,
    );
  }
  if (target instanceof CreateFailure) {
    const { message } = target;
    yield* Effect.sync(() => cancel(message, { output }));
    return yield* target;
  }
  const { targetDirectory, targetPathState } = target;

  const template =
    input.template ?? (useDefaults ? DEFAULT_TEMPLATE : yield* promptForCreateTemplate(output));

  if (force && targetPathState.exists) {
    const migrations = yield* inspectTargetPath(path.join(targetDirectory, "migrations"));
    if (migrations.exists && !migrations.isEmptyDirectory) {
      const message = `Target directory ${formatPathForDisplay(targetDirectory)} contains migration history. Create a starter in a new directory, or continue working in the existing project with the Prisma CLI. --force cannot overwrite a project with existing migrations.`;
      yield* Effect.sync(() => cancel(message, { output }));
      return yield* new CreateFailure({
        stage: "collect_context",
        reason: "target_has_migrations",
        message,
        errorReported: true,
      });
    }
  }

  const prismaSetupContext = yield* collectPrismaSetupContextEffect(input, {
    projectDir: targetDirectory,
    template,
  });
  return {
    targetDirectory,
    targetPathState,
    force,
    template,
    projectPackageName: toPackageName(path.basename(targetDirectory)),
    prismaSetupContext,
  } satisfies CreatePromptContext;
});
