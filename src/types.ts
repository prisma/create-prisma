import { Effect, Schema, SchemaTransformation } from "effect";

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

export const DatabaseProviderInputSchema = Schema.Literals(databaseProviderInputs);
export const DatabaseProviderSchema = Schema.Literals(databaseProviders);
export type DatabaseProvider = typeof DatabaseProviderSchema.Type;
export type DatabaseProviderInput = typeof DatabaseProviderInputSchema.Type;

export const PackageManagerSchema = Schema.Literals(packageManagers);
export type PackageManager = typeof PackageManagerSchema.Type;

export const AuthoringStyleSchema = Schema.Literals(authoringStyles);
export type AuthoringStyle = typeof AuthoringStyleSchema.Type;

export const CreateTemplateSchema = Schema.Literals(createTemplates);
export type CreateTemplate = typeof CreateTemplateSchema.Type;

const OptionalBoolean = Schema.optionalKey(Schema.Boolean);
const OptionalTrimmedString = Schema.optionalKey(Schema.Trim);
const OptionalNonEmptyTrimmedString = Schema.optionalKey(
  Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString, SchemaTransformation.passthrough())),
);

export const CommonCommandOptionsSchema = Schema.Struct({
  yes: OptionalBoolean,
  verbose: OptionalBoolean,
  json: OptionalBoolean,
});

export const PrismaSetupOptionsSchema = Schema.Struct({
  provider: Schema.optionalKey(DatabaseProviderSchema),
  authoring: Schema.optionalKey(AuthoringStyleSchema),
  packageManager: Schema.optionalKey(PackageManagerSchema),
  deploy: OptionalBoolean,
  workspace: OptionalNonEmptyTrimmedString,
});

export const PrismaSetupCommandInputSchema = Schema.Struct({
  ...CommonCommandOptionsSchema.fields,
  ...PrismaSetupOptionsSchema.fields,
});
export type PrismaSetupCommandInput = typeof PrismaSetupCommandInputSchema.Type;

export const CreateScaffoldOptionsSchema = Schema.Struct({
  name: OptionalTrimmedString,
  template: Schema.optionalKey(CreateTemplateSchema),
  force: OptionalBoolean,
});

export const CreateCommandInputSchema = Schema.Struct({
  ...PrismaSetupCommandInputSchema.fields,
  ...CreateScaffoldOptionsSchema.fields,
});
export type CreateCommandInput = typeof CreateCommandInputSchema.Type;

export const decodeCreateCommandInput = Schema.decodeUnknownEffect(CreateCommandInputSchema);

export function normalizeDatabaseProvider(value: DatabaseProviderInput): DatabaseProvider {
  switch (value) {
    case "postgresql":
      return "postgres";
    case "mongodb":
      return "mongo";
    default:
      return value;
  }
}

export function decodeCreateCommandInputSync(input: unknown): CreateCommandInput {
  return Effect.runSync(decodeCreateCommandInput(input));
}
