import { z } from "zod";

export const databaseProviders = [
  "postgresql",
  "mysql",
  "sqlite",
  "sqlserver",
  "cockroachdb",
] as const;

export const packageManagers = ["npm", "pnpm", "bun"] as const;
export const schemaPresets = ["empty", "basic"] as const;
export const createTemplates = ["hono", "next"] as const;

export const DatabaseProviderSchema = z.enum(databaseProviders);
export type DatabaseProvider = z.infer<typeof DatabaseProviderSchema>;
export const PackageManagerSchema = z.enum(packageManagers);
export type PackageManager = z.infer<typeof PackageManagerSchema>;
export const SchemaPresetSchema = z.enum(schemaPresets);
export type SchemaPreset = z.infer<typeof SchemaPresetSchema>;
export const CreateTemplateSchema = z.enum(createTemplates);
export type CreateTemplate = z.infer<typeof CreateTemplateSchema>;

export const DatabaseUrlSchema = z
  .string()
  .trim()
  .min(1, "Please enter a valid database URL");

export const CommonCommandOptionsSchema = z.object({
  yes: z
    .boolean()
    .optional()
    .describe("Skip prompts and accept default choices"),
  verbose: z
    .boolean()
    .optional()
    .describe("Show verbose command output during setup"),
});

export const PrismaSetupOptionsSchema = z.object({
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
  generate: z
    .boolean()
    .optional()
    .describe("Generate Prisma Client after scaffolding"),
  schemaPreset: SchemaPresetSchema.optional().describe(
    "Schema preset to scaffold in prisma/schema.prisma"
  ),
});

export const InitCommandInputSchema = CommonCommandOptionsSchema.merge(
  PrismaSetupOptionsSchema
);
export type InitCommandInput = z.infer<typeof InitCommandInputSchema>;

export const CreateScaffoldOptionsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Please enter a valid project name")
    .optional()
    .describe("Project name / directory"),
  template: CreateTemplateSchema.optional().describe("Project template"),
  force: z
    .boolean()
    .optional()
    .describe("Allow scaffolding into a non-empty target directory"),
});

export const CreateCommandInputSchema = CommonCommandOptionsSchema.merge(
  CreateScaffoldOptionsSchema
).merge(PrismaSetupOptionsSchema);
export type CreateCommandInput = z.infer<typeof CreateCommandInputSchema>;
