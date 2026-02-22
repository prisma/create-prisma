import { os } from "@orpc/server";
import { createCli } from "trpc-cli";

import { runCreateCommand } from "./commands/create";
import { runInitCommand } from "./commands/init";
import {
  InitCommandInputSchema,
  type CreateCommandInput,
  type InitCommandInput,
} from "./types";

const CLI_VERSION = process.env.CREATE_PRISMA_CLI_VERSION ?? "0.0.0";

export const router = os.router({
  init: os
    .meta({
      description: "Initialize Prisma in your current project",
      default: true,
      negateBooleans: true,
    })
    .input(InitCommandInputSchema.optional())
    .handler(async ({ input }) => {
      await runInitCommand(input ?? {});
    }),
  create: os
    .meta({
      description: "Alias for init",
      negateBooleans: true,
    })
    .input(InitCommandInputSchema.optional())
    .handler(async ({ input }) => {
      await runCreateCommand(input ?? {});
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

export async function create(input: InitCommandInput = {}): Promise<void> {
  await runCreateCommand(input);
}

export type { CreateCommandInput, InitCommandInput };
export {
  CreateCommandInputSchema,
  DatabaseProviderSchema,
  DatabaseUrlSchema,
  InitCommandInputSchema,
  PackageManagerSchema,
} from "./types";
