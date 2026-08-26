import { os } from "@orpc/server";
import { createCli } from "trpc-cli";
import { z } from "zod";

import { runCreateCommand } from "./commands/create";
import { CreateCommandInputSchema, type CreateCommandInput } from "./types";

const CLI_VERSION = process.env.CREATE_PRISMA_CLI_VERSION ?? "0.0.0";

const CreateCliInputSchema = z.tuple([
  z
    .string()
    .trim()
    .min(1, "Please enter a valid project name")
    .optional()
    .describe("Project name / directory"),
  CreateCommandInputSchema,
]);

function normalizeCreateCliInput(input: z.infer<typeof CreateCliInputSchema>): CreateCommandInput {
  const [projectName, options] = input;

  return {
    ...options,
    name: options.name ?? projectName,
  };
}

export const router = os.router({
  create: os
    .meta({
      description: "Create a new project with Prisma setup",
      default: true,
      negateBooleans: true,
    })
    .input(CreateCliInputSchema)
    .handler(async ({ input }) => {
      const createInput = normalizeCreateCliInput(input);
      const result = await runCreateCommand(createInput);
      return createInput.json ? result : undefined;
    }),
});

export function createCreatePrismaCli() {
  return createCli({
    router,
    name: "create-prisma",
    version: CLI_VERSION,
  });
}

export async function create(input: CreateCommandInput = {}): Promise<void> {
  await runCreateCommand(input);
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
export { CREATE_PRISMA_RESULT_SCHEMA_VERSION } from "./result";
export {
  AuthoringStyleSchema,
  CreateCommandInputSchema,
  CreateTemplateSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
} from "./types";
