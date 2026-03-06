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
export const createTemplates = ["hono", "next", "svelte", "astro", "nuxt", "turborepo"] as const;
export const createAddons = ["skills", "mcp", "extension"] as const;
export const addonInstallScopes = ["project", "global"] as const;
export const extensionTargets = ["vscode", "cursor", "windsurf"] as const;
export const prismaSkillNames = [
  "prisma-cli",
  "prisma-client-api",
  "prisma-database-setup",
  "prisma-upgrade-v7",
  "prisma-postgres",
] as const;

export const DatabaseProviderSchema = z.enum(databaseProviders);
export type DatabaseProvider = z.infer<typeof DatabaseProviderSchema>;
export const PackageManagerSchema = z.enum(packageManagers);
export type PackageManager = z.infer<typeof PackageManagerSchema>;
export const SchemaPresetSchema = z.enum(schemaPresets);
export type SchemaPreset = z.infer<typeof SchemaPresetSchema>;
export const CreateTemplateSchema = z.enum(createTemplates);
export type CreateTemplate = z.infer<typeof CreateTemplateSchema>;
export const CreateAddonSchema = z.enum(createAddons);
export type CreateAddon = z.infer<typeof CreateAddonSchema>;
export const AddonInstallScopeSchema = z.enum(addonInstallScopes);
export type AddonInstallScope = z.infer<typeof AddonInstallScopeSchema>;
export const ExtensionTargetSchema = z.enum(extensionTargets);
export type ExtensionTarget = z.infer<typeof ExtensionTargetSchema>;
export const PrismaSkillNameSchema = z.enum(prismaSkillNames);
export type PrismaSkillName = z.infer<typeof PrismaSkillNameSchema>;

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

export const PrismaSetupCommandInputSchema = CommonCommandOptionsSchema.extend(
  PrismaSetupOptionsSchema.shape
);
export type PrismaSetupCommandInput = z.infer<
  typeof PrismaSetupCommandInputSchema
>;

export const CreateScaffoldOptionsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Please enter a valid project name")
    .optional()
    .describe("Project name / directory"),
  template: CreateTemplateSchema.optional().describe("Project template"),
  skills: z
    .boolean()
    .optional()
    .describe("Enable skills addon"),
  mcp: z
    .boolean()
    .optional()
    .describe("Enable MCP addon"),
  extension: z
    .boolean()
    .optional()
    .describe("Enable extension addon"),
  force: z
    .boolean()
    .optional()
    .describe("Allow scaffolding into a non-empty target directory"),
});

export const CreateCommandInputSchema = PrismaSetupCommandInputSchema.extend(
  CreateScaffoldOptionsSchema.shape
);
export type CreateCommandInput = z.infer<typeof CreateCommandInputSchema>;

export type CreateTargetPathState = {
  exists: boolean;
  isDirectory: boolean;
  isEmptyDirectory: boolean;
};

export type PrismaSetupRunOptions = {
  prependNextSteps?: string[];
  projectDir?: string;
  includeDevNextStep?: boolean;
};

export type PrismaSetupResult = {
  packageManager: PackageManager;
};

export type PrismaPostgresProvisionResult = {
  databaseUrl?: string;
  claimUrl?: string;
  warning?: string;
};

export type PrismaGenerateResult = {
  didGenerateClient: boolean;
  warning?: string;
};

export type PrismaSetupContext = {
  projectDir: string;
  verbose: boolean;
  shouldGenerate: boolean;
  databaseProvider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  databaseUrl?: string;
  shouldUsePrismaPostgres: boolean;
  packageManager: PackageManager;
  shouldInstall: boolean;
};

export type CreatePromptContext = {
  targetDirectory: string;
  targetPathState: CreateTargetPathState;
  force: boolean;
  template: CreateTemplate;
  schemaPreset: SchemaPreset;
  projectPackageName: string;
  prismaSetupContext: PrismaSetupContext;
  addonSetupContext?: CreateAddonSetupContext;
};

export type CreateAddonSetupContext = {
  addons: CreateAddon[];
  scope: AddonInstallScope;
  skills: PrismaSkillName[];
  skillsAgents: string[];
  mcpAgents: string[];
  extensionTargets: ExtensionTarget[];
};

export type CreateTemplateContext = {
  projectName: string;
  provider: DatabaseProvider;
  schemaPreset: SchemaPreset;
  packageManager?: PackageManager;
};

export type ScaffoldedPrismaPaths = {
  schemaPath: string;
  configPath: string;
  singletonPath: string;
};

export type PrismaPostgresResult = {
  databaseUrl: string;
  claimUrl?: string;
};

export type DependencyWriteResult = {
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
  addedScripts: string[];
  existingScripts: string[];
};

export type EnvStatus = "created" | "appended" | "existing" | "updated";
export type FileAppendStatus = "created" | "appended" | "existing";

export type FinalizePrismaOptions = {
  provider: DatabaseProvider;
  databaseUrl?: string;
  claimUrl?: string;
  projectDir?: string;
};

export type FinalizePrismaResult = {
  schemaPath: string;
  configPath: string;
  singletonPath: string;
  envPath: string;
  envStatus: EnvStatus;
  gitignorePath: string;
  gitignoreStatus: FileAppendStatus;
  claimEnvStatus?: EnvStatus;
};
