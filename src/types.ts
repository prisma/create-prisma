import { Effect, Schema, SchemaTransformation } from "effect";

export const databaseProviders = ["postgres", "mongo"] as const;
export const databaseProviderInputs = ["postgres", "postgresql", "mongo", "mongodb"] as const;
export const packageManagers = ["npm", "pnpm", "yarn", "bun", "deno"] as const;
export const authoringStyles = ["psl", "typescript"] as const;
export const agentSkillTargets = ["claude", "cursor", "agents", "devin"] as const;
export const SKILLS_NONE = "none";
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

export const AgentSkillTargetSchema = Schema.Literals(agentSkillTargets);
export type AgentSkillTarget = typeof AgentSkillTargetSchema.Type;

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
  skills: OptionalNonEmptyTrimmedString,
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

export function isAgentSkillTarget(name: string): name is AgentSkillTarget {
  return (agentSkillTargets as readonly string[]).includes(name);
}

export type AgentSkillSelection =
  | { ok: true; agents: readonly AgentSkillTarget[] }
  | { ok: false; message: string };

/** Parses `--skills`: a comma-separated list of agent names, or `none`. */
export function parseAgentSkillSelection(value: string): AgentSkillSelection {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const known = agentSkillTargets.join(", ");
  if (names.includes(SKILLS_NONE)) {
    return names.length === 1
      ? { ok: true, agents: [] }
      : { ok: false, message: `--skills ${SKILLS_NONE} cannot be combined with agent names.` };
  }
  const agents: AgentSkillTarget[] = [];
  for (const name of names) {
    if (!isAgentSkillTarget(name)) {
      return {
        ok: false,
        message: `--skills names '${name}', which is not a known agent. Use a comma-separated list of ${known}, or ${SKILLS_NONE}.`,
      };
    }
    if (!agents.includes(name)) agents.push(name);
  }
  if (agents.length === 0) {
    return {
      ok: false,
      message: `--skills was given no agent names. Use a comma-separated list of ${known}, or ${SKILLS_NONE}.`,
    };
  }
  return { ok: true, agents };
}

export function decodeCreateCommandInputSync(input: unknown): CreateCommandInput {
  return Effect.runSync(decodeCreateCommandInput(input));
}
