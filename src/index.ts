import { os } from "@orpc/server";
import { createCli } from "trpc-cli";

import { runCreateCommand } from "./commands/create";
import {
  CreateCommandInputSchema,
  type CreateCommandInput,
} from "./types";

const CLI_VERSION = process.env.CREATE_PRISMA_CLI_VERSION ?? "0.0.0";

function usesExplicitCreateSubcommand(argv = process.argv): boolean {
  return argv.slice(2)[0] === "create";
}

export const router = os.router({
  create: os
    .meta({
      description: "Create a new project with Prisma setup",
      default: true,
      negateBooleans: true,
    })
    .input(CreateCommandInputSchema.optional())
    .handler(async ({ input }) => {
      await runCreateCommand(input ?? {}, {
        // Preserve smart init for `create-prisma`, but keep explicit
        // `create-prisma create` on the scaffolding path.
        allowInitCurrentProject: !usesExplicitCreateSubcommand(),
      });
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
  await runCreateCommand(input, {
    allowInitCurrentProject: false,
  });
}

export type { CreateCommandInput };
export {
  CreateCommandInputSchema,
  CreateTemplateSchema,
  DatabaseProviderSchema,
  DatabaseUrlSchema,
  PackageManagerSchema,
  SchemaPresetSchema,
} from "./types";
