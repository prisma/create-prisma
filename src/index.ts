import { Console, Effect, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";

import { runCreateCommandEffect } from "./commands/create";
import { createCommandFailureResult } from "./result";
import { applicationRuntime } from "./runtime";
import {
  authoringStyles,
  createTemplates,
  databaseProviderInputs,
  normalizeDatabaseProvider,
  packageManagers,
  type CreateCommandInput,
} from "./types";
import { isJsonOutputRequested, writeJsonResult } from "./ui/json-output";
import { getErrorMessage } from "./utils/errors";

const CLI_VERSION = process.env.CREATE_PRISMA_CLI_VERSION ?? "0.0.0";

const optionalArgument = (name: string, description: string) =>
  Argument.string(name).pipe(
    Argument.withDescription(description),
    Argument.optional,
    Argument.map(Option.getOrUndefined),
  );
const optionalBoolean = (name: string, description: string) =>
  Flag.boolean(name).pipe(
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  );
const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  );

export const createPrismaCommand = Command.make(
  "create-prisma",
  {
    projectName: optionalArgument("project-name", "Project name / directory"),
    name: optionalString("name", "Project name / directory"),
    template: Flag.choice("template", createTemplates).pipe(
      Flag.withDescription("Project template"),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    provider: Flag.choice("provider", databaseProviderInputs).pipe(
      Flag.withDescription("Database provider"),
      Flag.optional,
      Flag.map(Option.map(normalizeDatabaseProvider)),
      Flag.map(Option.getOrUndefined),
    ),
    authoring: Flag.choice("authoring", authoringStyles).pipe(
      Flag.withDescription("Contract authoring style"),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    packageManager: Flag.choice("package-manager", packageManagers).pipe(
      Flag.withDescription("Package manager used for dependency installation"),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    deploy: optionalBoolean("deploy", "Deploy the generated app to Prisma immediately"),
    workspace: optionalString("workspace", "Prisma workspace id or name to deploy into"),
    force: optionalBoolean("force", "Allow scaffolding into a non-empty target directory"),
    yes: optionalBoolean("yes", "Skip prompts and accept default choices"),
    verbose: optionalBoolean("verbose", "Show verbose command output during setup"),
    json: optionalBoolean(
      "json",
      "Emit one quiet JSON result for agents and automation (non-interactive; deploys unless --no-deploy)",
    ),
  },
  Effect.fn("Cli.create")(function* (options) {
    const input: CreateCommandInput = {
      ...((options.name ?? options.projectName)
        ? { name: options.name ?? options.projectName }
        : {}),
      ...(options.template ? { template: options.template } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.authoring ? { authoring: options.authoring } : {}),
      ...(options.packageManager ? { packageManager: options.packageManager } : {}),
      ...(options.deploy !== undefined ? { deploy: options.deploy } : {}),
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.yes !== undefined ? { yes: options.yes } : {}),
      ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
      ...(options.json !== undefined ? { json: options.json } : {}),
    };
    const result = yield* runCreateCommandEffect(input);
    if (input.json) yield* writeJsonResult(result);
    if (!result.ok) yield* Effect.sync(() => void (process.exitCode = 1));
  }),
).pipe(
  Command.withDescription("Create a new project with Prisma setup"),
  Command.withExamples([
    { command: "create-prisma my-app", description: "Create a project interactively" },
    {
      command: "create-prisma my-app --yes --json",
      description: "Create and deploy with machine-readable output",
    },
  ]),
);

const silentConsole: Console.Console = Object.assign(Object.create(console), {
  log() {},
  error() {},
});

export function createCreatePrismaCli() {
  return createPrismaCommand;
}

export function runCreatePrismaCli(argv: readonly string[] = process.argv.slice(2)) {
  const json = isJsonOutputRequested(argv);
  const args = argv[0] === "create" ? argv.slice(1) : argv;
  let program = Command.runWith(createPrismaCommand, {
    version: CLI_VERSION,
    renderErrors: !json,
  })(args).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (error instanceof CliError.ShowHelp && error.errors.length === 0) return;
        process.exitCode = 1;
        if (json) {
          const message =
            error instanceof CliError.ShowHelp
              ? error.errors.map((item) => item.message).join("; ")
              : getErrorMessage(error);
          yield* writeJsonResult(createCommandFailureResult("parse_arguments", message));
        }
      }),
    ),
  );
  if (json) program = Effect.provideService(program, Console.Console, silentConsole);
  return program;
}

export function create(input: CreateCommandInput = {}): Promise<void> {
  return applicationRuntime.runPromise(runCreateCommandEffect(input).pipe(Effect.asVoid));
}

export type { CreateCommandInput };
export type {
  CreateCommandFailureStage,
  CreateCommandFailureResult,
  CreateCommandResult,
  CreateCommandSuccessResult,
  CreateNextStep,
  CreateProjectResult,
} from "./result";
export { CREATE_PRISMA_RESULT_SCHEMA_VERSION, CreateCommandResultSchema } from "./result";
export {
  AuthoringStyleSchema,
  CreateCommandInputSchema,
  CreateTemplateSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
} from "./types";
