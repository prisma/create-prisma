import { cancel, confirm, isCancel, select } from "@clack/prompts";
import { Effect, Schema } from "effect";
import path from "node:path";
import type { Writable } from "node:stream";

import { CreateCancellationError, CreateFailure } from "../../create-outcome";
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
} from "../../types";
import { resolveExecutionSettings } from "../../ui/output";
import { detectPackageManagerEffect } from "../../utils/package-manager";
import type { PrismaSetupContext } from "./types";

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgres";
const DEFAULT_AUTHORING: AuthoringStyle = "psl";

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
