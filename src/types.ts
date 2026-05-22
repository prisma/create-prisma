import { z } from "zod";

export const databaseProviders = ["postgres", "mongo"] as const;
export const databaseProviderInputs = ["postgres", "postgresql", "mongo", "mongodb"] as const;

export const packageManagers = ["npm", "pnpm", "yarn", "bun", "deno"] as const;
export const authoringStyles = ["psl", "typescript"] as const;
export const createTemplates = [
  "minimal",
  "hono",
  "elysia",
  "nest",
  "next",
  "svelte",
  "astro",
  "nuxt",
  "tanstack-start",
] as const;

type NormalizedDatabaseProvider = (typeof databaseProviders)[number];
type DatabaseProviderInput = (typeof databaseProviderInputs)[number];

function normalizeDatabaseProvider(value: DatabaseProviderInput): NormalizedDatabaseProvider {
  if (value === "postgresql") {
    return "postgres";
  }
  if (value === "mongodb") {
    return "mongo";
  }

  return value;
}

export const DatabaseProviderSchema = z
  .enum(databaseProviderInputs)
  .transform(normalizeDatabaseProvider);
export type DatabaseProvider = z.infer<typeof DatabaseProviderSchema>;
export const PackageManagerSchema = z.enum(packageManagers);
export type PackageManager = z.infer<typeof PackageManagerSchema>;
export const AuthoringStyleSchema = z.enum(authoringStyles);
export type AuthoringStyle = z.infer<typeof AuthoringStyleSchema>;
export const CreateTemplateSchema = z.enum(createTemplates);
export type CreateTemplate = z.infer<typeof CreateTemplateSchema>;

export const DatabaseUrlSchema = z.string().trim().min(1, "Please enter a valid database URL");

export const CommonCommandOptionsSchema = z.object({
  yes: z.boolean().optional().describe("Skip prompts and accept default choices"),
  verbose: z.boolean().optional().describe("Show verbose command output during setup"),
});

export const PrismaSetupOptionsSchema = z.object({
  provider: DatabaseProviderSchema.optional().describe(
    "Prisma Next database target: PostgreSQL relational models or MongoDB document models",
  ),
  authoring: AuthoringStyleSchema.optional().describe("Contract authoring style"),
  packageManager: PackageManagerSchema.optional().describe(
    "Package manager used for dependency installation",
  ),
  prismaPostgres: z
    .boolean()
    .optional()
    .describe("Provision Prisma Postgres with create-db when target is postgres"),
  databaseUrl: DatabaseUrlSchema.optional().describe("DATABASE_URL value"),
  install: z.boolean().optional().describe("Install dependencies with selected package manager"),
  emit: z.boolean().optional().describe("Emit Prisma Next contract artifacts after scaffolding"),
});

export const PrismaSetupCommandInputSchema = CommonCommandOptionsSchema.extend(
  PrismaSetupOptionsSchema.shape,
);
export type PrismaSetupCommandInput = z.infer<typeof PrismaSetupCommandInputSchema>;

export const CreateScaffoldOptionsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Please enter a valid project name")
    .optional()
    .describe("Project name / directory"),
  template: CreateTemplateSchema.optional().describe("Project template"),
  force: z.boolean().optional().describe("Allow scaffolding into a non-empty target directory"),
});

export const CreateCommandInputSchema = PrismaSetupCommandInputSchema.extend(
  CreateScaffoldOptionsSchema.shape,
);
export type CreateCommandInput = z.infer<typeof CreateCommandInputSchema>;
