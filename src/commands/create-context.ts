import { cancel, isCancel, select, text } from "@clack/prompts";
import { Effect, FileSystem, Schema } from "effect";
import path from "node:path";
import type { Writable } from "node:stream";

import { CreateCancellationError, CreateFailure } from "../create-outcome";
import type { CreateProjectResult } from "../result";
import { collectPrismaSetupContextEffect, type PrismaSetupContext } from "../tasks/setup-prisma";
import { CreateTemplateSchema, type CreateCommandInput, type CreateTemplate } from "../types";
import { resolveExecutionSettings } from "../ui/output";

const DEFAULT_PROJECT_NAME = "my-app";
const DEFAULT_TEMPLATE: CreateTemplate = "minimal";

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

const promptForProjectName = Effect.fn("Prompts.projectName")(function* (output: Writable) {
  const value = yield* Effect.tryPromise(() =>
    text({
      message: "Project name",
      placeholder: DEFAULT_PROJECT_NAME,
      initialValue: DEFAULT_PROJECT_NAME,
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

export const collectCreateContext = Effect.fn("Create.collectContext")(function* (
  input: CreateCommandInput,
) {
  const force = input.force === true;
  const { output, useDefaults } = resolveExecutionSettings(input);
  const projectName = String(
    input.name ?? (useDefaults ? DEFAULT_PROJECT_NAME : yield* promptForProjectName(output)),
  ).trim();
  const validationError = validateProjectName(projectName);
  if (validationError) {
    yield* Effect.sync(() => cancel(validationError, { output }));
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "invalid_project_name",
      message: validationError,
      errorReported: true,
    });
  }

  const template =
    input.template ?? (useDefaults ? DEFAULT_TEMPLATE : yield* promptForCreateTemplate(output));
  const targetDirectory = path.resolve(process.cwd(), projectName);
  const targetPathState = yield* inspectTargetPath(targetDirectory);
  if (targetPathState.exists && !targetPathState.isDirectory) {
    const message = `Target path ${formatPathForDisplay(targetDirectory)} already exists and is not a directory. Choose a different project name.`;
    yield* Effect.sync(() => cancel(message, { output }));
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "target_path_not_directory",
      message,
      errorReported: true,
    });
  }
  if (targetPathState.exists && !targetPathState.isEmptyDirectory && !force) {
    const message = `Target directory ${formatPathForDisplay(targetDirectory)} is not empty. Use --force to continue.`;
    yield* Effect.sync(() => cancel(message, { output }));
    return yield* new CreateFailure({
      stage: "collect_context",
      reason: "target_directory_not_empty",
      message,
      errorReported: true,
    });
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
