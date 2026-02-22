import { z } from "zod";

export const databaseProviders = [
  "postgresql",
  "mysql",
  "sqlite",
  "sqlserver",
  "cockroachdb",
] as const;

export const packageManagers = ["npm", "pnpm", "bun"] as const;

export const DatabaseProviderSchema = z.enum(databaseProviders);
export type DatabaseProvider = z.infer<typeof DatabaseProviderSchema>;
export const PackageManagerSchema = z.enum(packageManagers);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const DatabaseUrlSchema = z
  .string()
  .trim()
  .min(1, "Please enter a valid database URL");

export const InitCommandInputSchema = z.object({
  yes: z
    .boolean()
    .optional()
    .describe("Skip prompts and accept default choices"),
  provider: DatabaseProviderSchema.optional().describe("Database provider"),
  packageManager: PackageManagerSchema.optional().describe(
    "Package manager used for dependency installation"
  ),
  prismaPostgres: z
    .boolean()
    .optional()
    .describe(
      "Provision Prisma Postgres with create-db when provider is postgresql"
    ),
  databaseUrl: DatabaseUrlSchema.optional().describe("DATABASE_URL value"),
  install: z
    .boolean()
    .optional()
    .describe("Install dependencies with selected package manager"),
});

export type InitCommandInput = z.infer<typeof InitCommandInputSchema>;
export const CreateCommandInputSchema = InitCommandInputSchema;
export type CreateCommandInput = InitCommandInput;
