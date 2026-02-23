import { os } from "@orpc/server";
import { createCli } from "trpc-cli";

import { runCreateCommand } from "./commands/create";
import { runInitCommand } from "./commands/init";
import {
  CreateCommandInputSchema,
  InitCommandInputSchema,
  type CreateCommandInput,
  type InitCommandInput,
} from "./types";

const CLI_VERSION = process.env.CREATE_PRISMA_CLI_VERSION ?? "0.0.0";

export const router = os.router({
  create: os
    .meta({
      description: "Create a new project with Prisma setup",
      default: true,
      negateBooleans: true,
    })
    .input(CreateCommandInputSchema.optional())
    .handler(async ({ input }) => {
      await runCreateCommand(input ?? {});
    }),
  init: os
    .meta({
      description: "Initialize Prisma in your current project",
      negateBooleans: true,
    })
    .input(InitCommandInputSchema.optional())
    .handler(async ({ input }) => {
      await runInitCommand(input ?? {});
    }),
});

export function createCreatePrismaCli() {
  return createCli({
    router,
    name: "create-prisma",
    version: CLI_VERSION,
  });
}

export async function init(input: InitCommandInput = {}): Promise<void> {
  await runInitCommand(input);
}

export async function create(input: CreateCommandInput = {}): Promise<void> {
  await runCreateCommand(input);
}

export type { CreateCommandInput, InitCommandInput };
export {
  CreateCommandInputSchema,
  CreateTemplateSchema,
  DatabaseProviderSchema,
  DatabaseUrlSchema,
  InitCommandInputSchema,
  PackageManagerSchema,
  SchemaPresetSchema,
} from "./types";
