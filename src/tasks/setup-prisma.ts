import { cancel, confirm, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import { execa } from "execa";
import fs from "fs-extra";
import path from "node:path";

import { installProjectDependencies, writePrismaDependencies } from "./install";
import {
  getCreateDbCommand,
  PRISMA_POSTGRES_TEMPORARY_NOTICE,
  provisionPrismaPostgres,
} from "./prisma-postgres";
import { dependencyVersionMap } from "../constants/dependencies";
import {
  AuthoringStyleSchema,
  DatabaseProviderSchema,
  PackageManagerSchema,
  type AuthoringStyle,
  type DatabaseProvider,
  type PackageManager,
  type PrismaSetupCommandInput,
  type SchemaPreset,
} from "../types";
import {
  detectPackageManager,
  getInstallCommand,
  getLocalPackageBinaryArgs,
  getLocalPackageBinaryCommand,
  getRunScriptCommand,
} from "../utils/package-manager";

type EnvWriteMode = "keep-existing" | "upsert";

type PrismaSetupRunOptions = {
  prependNextSteps?: NextStep[];
  projectDir?: string;
  includeDevNextStep?: boolean;
};

type PrismaPostgresProvisionResult = {
  databaseUrl?: string;
  claimUrl?: string;
  warning?: string;
};

type PrismaNextEmitResult = {
  didEmitContract: boolean;
  warning?: string;
};

type PrismaNextProjectDocsOptions = {
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  schemaPreset: SchemaPreset;
  packageManager: PackageManager;
  projectDir: string;
};

type NextStep = {
  command: string;
  description: string;
};

export type PrismaSetupContext = {
  projectDir: string;
  verbose: boolean;
  shouldEmit: boolean;
  databaseProvider: DatabaseProvider;
  authoring: AuthoringStyle;
  schemaPreset: SchemaPreset;
  databaseUrl?: string;
  shouldUsePrismaPostgres: boolean;
  packageManager: PackageManager;
  shouldInstall: boolean;
};

type FinalizePrismaOptions = {
  provider: DatabaseProvider;
  databaseUrl?: string;
  claimUrl?: string;
  projectDir?: string;
};

const DEFAULT_DATABASE_PROVIDER: DatabaseProvider = "postgres";
const DEFAULT_AUTHORING: AuthoringStyle = "psl";
const DEFAULT_SCHEMA_PRESET: SchemaPreset = "basic";
const DEFAULT_INSTALL = true;
const DEFAULT_EMIT = true;
const DEFAULT_INTERACTIVE_PRISMA_POSTGRES = true;
const DEFAULT_AUTOMATED_PRISMA_POSTGRES = false;
const MONGO_DOCKER_COMPOSE = `services:
  mongodb:
    image: mongo:latest
    command: ["mongod", "--replSet", "rs0", "--bind_ip_all"]
    ports:
      - "27017:27017"
    volumes:
      - mongodb-data:/data/db
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "mongosh --quiet --eval 'try { rs.status().members.some((member) => member.stateStr === \\"PRIMARY\\") } catch (error) { rs.initiate({_id: \\"rs0\\", members: [{ _id: 0, host: \\"localhost:27017\\" }] }); false }' | grep true",
        ]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 5s

volumes:
  mongodb-data:
`;

const mongoDockerScripts = {
  "db:up": "docker compose up -d --wait",
  "db:down": "docker compose down",
} as const;

const minimumServerVersion = {
  postgres: "14",
  mongo: "6.0",
} satisfies Record<DatabaseProvider, string>;
const readmeSectionMarker = "<!-- prisma-next-reference -->";

const requiredPrismaFileGroups = [
  [
    "prisma/contract.prisma",
    "prisma/contract.ts",
    "packages/db/prisma/contract.prisma",
    "packages/db/prisma/contract.ts",
  ],
  ["prisma-next.config.ts", "packages/db/prisma-next.config.ts"],
  [
    "src/lib/prisma.ts",
    "src/lib/prisma.server.ts",
    "src/lib/server/prisma.ts",
    "server/utils/prisma.ts",
    "packages/db/src/client.ts",
  ],
] as const;

async function resolvePrismaProjectDir(projectDir: string): Promise<string> {
  const monorepoDbDir = path.join(projectDir, "packages/db");
  if (
    (await fs.pathExists(path.join(monorepoDbDir, "prisma/contract.prisma"))) ||
    (await fs.pathExists(path.join(monorepoDbDir, "prisma/contract.ts")))
  ) {
    return monorepoDbDir;
  }

  return projectDir;
}

function getDatabaseLabel(provider: DatabaseProvider): string {
  return provider === "mongo" ? "MongoDB" : "PostgreSQL";
}

function getContractPath(authoring: AuthoringStyle): string {
  return `prisma/contract${authoring === "typescript" ? ".ts" : ".prisma"}`;
}

function stripTypeScriptExtension(filePath: string): string {
  return filePath.endsWith(".ts") ? filePath.slice(0, -3) : filePath;
}

async function findFirstExistingRelativePath(
  projectDir: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await fs.pathExists(path.join(projectDir, candidate))) {
      return candidate;
    }
  }

  return undefined;
}

async function readPackageScripts(projectDir: string): Promise<Record<string, string>> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return {};
  }

  const packageJson = await fs.readJson(packageJsonPath);
  return typeof packageJson.scripts === "object" && packageJson.scripts !== null
    ? (packageJson.scripts as Record<string, string>)
    : {};
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  if (await fs.pathExists(filePath)) {
    return;
  }

  await fs.outputFile(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

async function appendReadmeSectionIfMissing(projectDir: string, content: string): Promise<void> {
  const readmePath = path.join(projectDir, "README.md");
  const section = `${readmeSectionMarker}\n${content.trim()}\n`;

  if (!(await fs.pathExists(readmePath))) {
    await fs.outputFile(readmePath, `# Prisma Next\n\n${section}`, "utf8");
    return;
  }

  const existingContent = await fs.readFile(readmePath, "utf8");
  if (existingContent.includes(readmeSectionMarker)) {
    return;
  }

  const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
  await fs.writeFile(readmePath, `${existingContent}${separator}${section}`, "utf8");
}

function getEnvExampleContent(provider: DatabaseProvider): string {
  const label = getDatabaseLabel(provider);
  const minVersion = minimumServerVersion[provider];
  const databaseUrl =
    provider === "mongo"
      ? "mongodb://localhost:27017/mydb?replicaSet=rs0&directConnection=true"
      : "postgresql://user:password@localhost:5432/mydb";

  return [
    "# Copy this file to .env and replace the placeholder with your connection string.",
    `# Requires ${label} >= ${minVersion}.`,
    `DATABASE_URL="${databaseUrl}"`,
    "",
  ].join("\n");
}

function formatCommandListItem(
  packageManager: PackageManager,
  scriptName: string,
  description: string,
): string {
  return `- \`${getRunScriptCommand(packageManager, scriptName)}\` - ${description}`;
}

function getPrismaNextReadmeSectionContent(options: {
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  schemaPreset: SchemaPreset;
  packageManager: PackageManager;
  schemaPath: string;
  dbImportPath: string;
  scripts: Record<string, string>;
  rootScripts: Record<string, string>;
}): string {
  const {
    provider,
    authoring,
    schemaPreset,
    packageManager,
    schemaPath,
    dbImportPath,
    scripts,
    rootScripts,
  } = options;
  const label = getDatabaseLabel(provider);
  const minVersion = minimumServerVersion[provider];
  const hasWorkspaceRootDbUp =
    typeof scripts["db:up"] !== "string" && typeof rootScripts["db:up"] === "string";
  const hasDbUp = typeof scripts["db:up"] === "string" || hasWorkspaceRootDbUp;
  const commandLines = [
    formatCommandListItem(
      packageManager,
      "contract:emit",
      "emit contract.json and contract.d.ts after contract changes",
    ),
    ...(hasDbUp
      ? [
          formatCommandListItem(
            packageManager,
            "db:up",
            hasWorkspaceRootDbUp
              ? "start the local MongoDB replica set with Docker from the workspace root"
              : "start the local MongoDB replica set with Docker",
          ),
        ]
      : []),
    formatCommandListItem(packageManager, "db:init", "bootstrap a new database from the contract"),
    formatCommandListItem(
      packageManager,
      "db:update",
      "apply contract changes directly after confirmation",
    ),
    formatCommandListItem(
      packageManager,
      "db:verify",
      "compare the live database state against the contract",
    ),
    formatCommandListItem(
      packageManager,
      "migration:plan",
      "write an offline migration plan from contract changes",
    ),
    formatCommandListItem(packageManager, "migration:apply", "apply pending migrations"),
    formatCommandListItem(
      packageManager,
      "migration:status",
      "show applied and pending migrations",
    ),
    formatCommandListItem(packageManager, "migration:show", "inspect a planned migration"),
    ...(schemaPreset === "basic"
      ? [formatCommandListItem(packageManager, "db:seed", "insert starter sample data")]
      : []),
  ];

  const workflowLines =
    provider === "mongo"
      ? [
          "1. Start MongoDB with Docker if you are using the generated local database.",
          "2. Run `contract:emit` after editing the contract.",
          "3. Run `migration:plan` and review the generated migration.",
          "4. Run `migration:apply` to apply pending migrations.",
          ...(schemaPreset === "basic"
            ? ["5. Run `db:seed` if you want the starter sample data."]
            : []),
        ]
      : [
          "1. Run `contract:emit` after editing the contract.",
          "2. For first-time setup, run `db:init` to create and sign the database state.",
          "3. For later contract changes, run `migration:plan` and `migration:apply`.",
          ...(schemaPreset === "basic"
            ? ["4. Run `db:seed` if you want the starter sample data."]
            : []),
        ];

  const queryExample =
    provider === "mongo"
      ? [
          "```ts",
          `import { db } from "${dbImportPath}";`,
          "",
          'for await (const user of db.orm.users.select("_id", "email").take(10).all()) {',
          "  console.log(user.email);",
          "}",
          "```",
          "",
          "MongoDB accessors use the emitted collection names, so the starter `User` model is queried through `db.orm.users`. The Mongo facade connects lazily on the first query; call `db.close()` when a script is done. Use `db.query` for typed aggregation pipelines when the ORM cannot express a query.",
        ]
      : [
          "```ts",
          `import { db } from "${dbImportPath}";`,
          "",
          'const users = await db.orm.User.select("id", "email").take(10).all();',
          "```",
          "",
          "PostgreSQL models use their contract model names, so the starter `User` model is queried through `db.orm.User`. Prefer `db.orm` for application queries and use raw SQL only when the ORM does not cover the operation.",
        ];

  return [
    "## Prisma Next Reference",
    "",
    `This project uses Prisma Next with ${label}. The contract is authored in ${authoring === "typescript" ? "TypeScript" : "PSL"} at \`${schemaPath}\`.`,
    "",
    "## Requirements",
    "",
    `- ${label} ${minVersion} or newer.`,
    "- The generated `.env.example` shows the expected `DATABASE_URL` shape.",
    ...(provider === "mongo"
      ? [
          "- The generated Docker Compose setup starts MongoDB as a replica set for local migration workflows.",
        ]
      : []),
    "",
    "## Contract Artifacts",
    "",
    "Prisma Next emits two generated files next to the contract:",
    "",
    "- `prisma/contract.json` - runtime contract metadata",
    "- `prisma/contract.d.ts` - TypeScript types for the contract",
    "",
    "Commit both generated files. Do not edit either one by hand.",
    "",
    "## Query Example",
    "",
    ...queryExample,
    "",
    "## Commands",
    "",
    ...commandLines,
    "",
    "## Workflow",
    "",
    ...workflowLines,
    "",
  ].join("\n");
}

function getPrismaNextAgentSkillContent(options: {
  provider: DatabaseProvider;
  authoring: AuthoringStyle;
  schemaPreset: SchemaPreset;
  packageManager: PackageManager;
  schemaPath: string;
  dbImportPath: string;
  scripts: Record<string, string>;
  rootScripts: Record<string, string>;
}): string {
  const {
    provider,
    authoring,
    schemaPreset,
    packageManager,
    schemaPath,
    dbImportPath,
    scripts,
    rootScripts,
  } = options;
  const label = getDatabaseLabel(provider);
  const runtimePackage = provider === "mongo" ? "@prisma-next/mongo" : "@prisma-next/postgres";
  const descriptionDetails =
    provider === "mongo"
      ? "MongoDB queries, DATABASE_URL, db init/update/verify, migrations, seeding, local MongoDB Docker setup, replica sets, typed aggregations, or mongoClient escape hatches."
      : "PostgreSQL queries, DATABASE_URL, db init/update/verify, migrations, seeding, PostgreSQL setup, or raw SQL escape hatches.";
  const hasWorkspaceRootDbUp =
    typeof scripts["db:up"] !== "string" && typeof rootScripts["db:up"] === "string";
  const hasDbUp = typeof scripts["db:up"] === "string" || hasWorkspaceRootDbUp;
  const commands = [
    formatCommandListItem(packageManager, "contract:emit", "regenerate contract artifacts"),
    ...(hasDbUp
      ? [
          formatCommandListItem(
            packageManager,
            "db:up",
            hasWorkspaceRootDbUp
              ? "start local MongoDB with Docker from the workspace root"
              : "start local MongoDB with Docker",
          ),
        ]
      : []),
    formatCommandListItem(packageManager, "db:init", "bootstrap a new database"),
    formatCommandListItem(packageManager, "db:update", "apply contract changes directly"),
    formatCommandListItem(
      packageManager,
      "db:verify",
      "verify database state against the contract",
    ),
    formatCommandListItem(packageManager, "migration:plan", "create an offline migration plan"),
    formatCommandListItem(packageManager, "migration:apply", "apply pending migrations"),
    formatCommandListItem(packageManager, "migration:status", "show migration status"),
    formatCommandListItem(packageManager, "migration:show", "inspect a migration"),
    ...(schemaPreset === "basic"
      ? [formatCommandListItem(packageManager, "db:seed", "insert starter sample data")]
      : []),
  ];

  const queryGuidance =
    provider === "mongo"
      ? [
          "- Use `db.orm`. Mongo root accessors are lowercased plural collection names emitted by `contract:emit`, for example `db.orm.users` and `db.orm.posts`.",
          "- `.all()` returns an async iterable result. Consume it with `for await` or await it to materialize an array.",
          "- Use `db.query` for typed aggregation pipelines when the ORM cannot express a query.",
          "- For direct MongoDB driver control, construct your own `MongoClient` and pass it through the `mongoClient` binding; keep that raw client reference for sessions, transactions, and change streams.",
          "- Do not use `db.runtime()` as a raw driver escape hatch. It returns Prisma Next's internal executor, not a `mongodb` `MongoClient` or `Db`.",
          "- The Mongo client connects lazily on the first query. Short-lived scripts should call `await db.close()` in `finally`.",
          "- Multi-document transactions and change streams require MongoDB to run as a replica set. The generated local Docker setup does this.",
        ]
      : [
          "- Use `db.orm`. PostgreSQL root accessors follow contract model names, for example `db.orm.User` and `db.orm.Post`.",
          "- Prefer `db.orm` for application queries. Use raw SQL only when the ORM cannot express the operation or the user explicitly asks for it.",
          "- `.where(...)`, `.select(...)`, `.orderBy(...)`, `.take(...)`, `.all()`, `.first()`, and `.include(...)` are the primary ORM query methods.",
          "- Short-lived scripts should close the runtime with `await db.runtime().close()` when needed.",
        ];

  const queryExamples =
    provider === "mongo"
      ? [
          "```ts",
          `import { db } from "${dbImportPath}";`,
          "",
          'const user = await db.orm.users.where({ email: "alice@example.com" }).first();',
          "",
          'for await (const user of db.orm.users.select("_id", "email").take(10).all()) {',
          "  console.log(user.email);",
          "}",
          "",
          "const usersWithPosts = await db.orm.users",
          '  .select("_id", "email")',
          '  .include("posts")',
          "  .take(10)",
          "  .all();",
          "```",
        ]
      : [
          "```ts",
          `import { db } from "${dbImportPath}";`,
          "",
          "const user = await db.orm.User",
          '  .where((user) => user.email.eq("alice@example.com"))',
          "  .first();",
          "",
          'const users = await db.orm.User.select("id", "email").take(10).all();',
          "",
          "const usersWithPosts = await db.orm.User",
          '  .select("id", "email")',
          '  .include("posts", (post) => post.select("id", "title").take(5))',
          "  .take(10)",
          "  .all();",
          "```",
        ];

  return [
    "---",
    "name: prisma-next",
    "description: >-",
    `  Prisma Next project workflow for this generated ${label} app. Use whenever working in this repository on Prisma Next contracts, generated contract artifacts, database helpers, ${descriptionDetails}`,
    "---",
    "",
    "# Prisma Next - Project Skill",
    "",
    `This project uses **Prisma Next** with **${label}** via \`${runtimePackage}\`. The contract is \`${schemaPath}\` using ${authoring === "typescript" ? "TypeScript" : "PSL"} authoring.`,
    "",
    "## Files",
    "",
    `- **Contract**: \`${schemaPath}\` - edit this to add or change models.`,
    "- **Config**: `prisma-next.config.ts` - tells the CLI where the contract is and how to connect to the database.",
    `- **Database helper**: import \`db\` from \`${dbImportPath}\`. This is the entry point for queries.`,
    "- **Generated files**: `prisma/contract.json` and `prisma/contract.d.ts`. Do not edit these by hand.",
    "",
    "## Commands",
    "",
    ...commands,
    "",
    "## How To Write Queries",
    "",
    ...queryExamples,
    "",
    "## Rules",
    "",
    "- Never hand-edit `contract.json` or `contract.d.ts`. Regenerate them with `contract:emit`.",
    "- Always run `contract:emit` after changing the contract before writing code that depends on the changed models.",
    "- Do not auto-run `db:init`, migrations, or seed commands. These are manual project-owner actions.",
    "- Do not restructure the generated database helper unless the user explicitly asks.",
    "- `DATABASE_URL` lives in `.env`; `.env.example` documents the expected shape and minimum server version.",
    ...queryGuidance,
    "",
    "## Common Workflow",
    "",
    "- Edit the contract.",
    "- Run `contract:emit`.",
    "- For a new database, run `db:init`.",
    "- For existing databases, run `migration:plan`, review it, then run `migration:apply`.",
    "- Run `db:verify` or `migration:status` when checking state.",
    "",
  ].join("\n");
}

async function writePrismaNextProjectDocs(options: PrismaNextProjectDocsOptions): Promise<void> {
  const prismaProjectDir = await resolvePrismaProjectDir(options.projectDir);
  const schemaPath = getContractPath(options.authoring);
  const dbHelperPath =
    (await findFirstExistingRelativePath(prismaProjectDir, [
      "src/lib/prisma.ts",
      "src/lib/prisma.server.ts",
      "src/lib/server/prisma.ts",
      "server/utils/prisma.ts",
      "src/client.ts",
    ])) ?? "src/lib/prisma.ts";
  const dbImportPath = `./${stripTypeScriptExtension(dbHelperPath)}`;
  const scripts = await readPackageScripts(prismaProjectDir);
  const rootScripts = await readPackageScripts(options.projectDir);

  await writeFileIfMissing(
    path.join(prismaProjectDir, ".env.example"),
    getEnvExampleContent(options.provider),
  );
  await appendReadmeSectionIfMissing(
    prismaProjectDir,
    getPrismaNextReadmeSectionContent({
      provider: options.provider,
      authoring: options.authoring,
      schemaPreset: options.schemaPreset,
      packageManager: options.packageManager,
      schemaPath,
      dbImportPath,
      scripts,
      rootScripts,
    }),
  );
  await writeFileIfMissing(
    path.join(prismaProjectDir, ".agents/skills/prisma-next/SKILL.md"),
    getPrismaNextAgentSkillContent({
      provider: options.provider,
      authoring: options.authoring,
      schemaPreset: options.schemaPreset,
      packageManager: options.packageManager,
      schemaPath,
      dbImportPath,
      scripts,
      rootScripts,
    }),
  );
}

async function promptForDatabaseProvider(): Promise<DatabaseProvider | undefined> {
  const databaseProvider = await select({
    message: "Select your database",
    initialValue: DEFAULT_DATABASE_PROVIDER,
    options: [
      {
        value: "postgres",
        label: "PostgreSQL",
        hint: "Relational models with typed ORM, relations, indexes, raw SQL",
      },
      {
        value: "mongo",
        label: "MongoDB",
        hint: "Document models with typed ORM, indexes, aggregations",
      },
    ],
  });

  if (isCancel(databaseProvider)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return DatabaseProviderSchema.parse(databaseProvider);
}

async function promptForAuthoringStyle(): Promise<AuthoringStyle | undefined> {
  const authoring = await select({
    message: "Choose contract authoring style",
    initialValue: DEFAULT_AUTHORING,
    options: [
      { value: "psl", label: "PSL", hint: "Schema syntax emits contract.json + types" },
      {
        value: "typescript",
        label: "TypeScript",
        hint: "Builder API emits the same contract artifacts",
      },
    ],
  });

  if (isCancel(authoring)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return AuthoringStyleSchema.parse(authoring);
}

async function promptForPrismaPostgres(): Promise<boolean | undefined> {
  const shouldUsePrismaPostgres = await confirm({
    message: "Provision a Prisma Postgres database?",
    active: "Provision Prisma Postgres",
    inactive: "Use my own database",
    initialValue: DEFAULT_INTERACTIVE_PRISMA_POSTGRES,
  });

  if (isCancel(shouldUsePrismaPostgres)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return Boolean(shouldUsePrismaPostgres);
}

function getPackageManagerHint(
  option: PackageManager,
  detected: PackageManager,
): string | undefined {
  const hintByPackageManager = {
    npm: "Node.js default",
    pnpm: "Fast, disk-efficient Node.js package manager",
    yarn: "Yarn package manager",
    bun: "Fast runtime + package manager",
    deno: "Deno runtime + task runner",
  } satisfies Record<PackageManager, string>;

  const hint = hintByPackageManager[option];
  return option === detected ? `Detected; ${hint}` : hint;
}

async function promptForPackageManager(
  detectedPackageManager: PackageManager,
): Promise<PackageManager | undefined> {
  const packageManager = await select({
    message: "Choose package manager",
    initialValue: detectedPackageManager,
    options: [
      {
        value: "npm",
        label: "npm",
        hint: getPackageManagerHint("npm", detectedPackageManager),
      },
      {
        value: "pnpm",
        label: "pnpm",
        hint: getPackageManagerHint("pnpm", detectedPackageManager),
      },
      {
        value: "yarn",
        label: "yarn",
        hint: getPackageManagerHint("yarn", detectedPackageManager),
      },
      {
        value: "bun",
        label: "bun",
        hint: getPackageManagerHint("bun", detectedPackageManager),
      },
      {
        value: "deno",
        label: "deno",
        hint: getPackageManagerHint("deno", detectedPackageManager),
      },
    ],
  });

  if (isCancel(packageManager)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return PackageManagerSchema.parse(packageManager);
}

async function promptForDependencyInstall(
  packageManager: PackageManager,
): Promise<boolean | undefined> {
  const installCommand = getInstallCommand(packageManager);
  const shouldInstall = await confirm({
    message: `Install dependencies now with ${installCommand}? You can run it later.`,
    active: "Install now",
    inactive: "Skip for now",
    initialValue: true,
  });

  if (isCancel(shouldInstall)) {
    cancel("Operation cancelled.");
    return undefined;
  }

  return Boolean(shouldInstall);
}

function getCommandErrorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    if (stderr.length > 0) {
      return stderr;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

export async function collectPrismaSetupContext(
  input: PrismaSetupCommandInput,
  options: {
    projectDir?: string;
    defaultSchemaPreset?: SchemaPreset;
  } = {},
): Promise<PrismaSetupContext | undefined> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const useDefaults = input.yes === true;
  const verbose = input.verbose === true;
  const shouldEmit = input.emit ?? DEFAULT_EMIT;

  const databaseProvider =
    input.provider ?? (useDefaults ? DEFAULT_DATABASE_PROVIDER : await promptForDatabaseProvider());
  if (!databaseProvider) {
    return;
  }

  const databaseUrl = input.databaseUrl;
  const shouldUsePrismaPostgres =
    input.prismaPostgres ??
    (databaseProvider === "postgres" && !databaseUrl && !useDefaults
      ? await promptForPrismaPostgres()
      : DEFAULT_AUTOMATED_PRISMA_POSTGRES);
  if (shouldUsePrismaPostgres === undefined) {
    return;
  }

  if (shouldUsePrismaPostgres && databaseProvider !== "postgres") {
    cancel("--prisma-postgres is only supported with --provider postgres.");
    return;
  }
  if (shouldUsePrismaPostgres && databaseUrl) {
    cancel("Use either --database-url or --prisma-postgres, not both.");
    return;
  }

  const authoring =
    input.authoring ?? (useDefaults ? DEFAULT_AUTHORING : await promptForAuthoringStyle());
  if (!authoring) {
    return;
  }

  const schemaPreset = input.schemaPreset ?? options.defaultSchemaPreset ?? DEFAULT_SCHEMA_PRESET;

  const detectedPackageManager = await detectPackageManager(projectDir);
  const packageManager =
    input.packageManager ??
    (useDefaults ? detectedPackageManager : await promptForPackageManager(detectedPackageManager));
  if (!packageManager) {
    return;
  }

  const shouldInstall =
    input.install ??
    (useDefaults ? DEFAULT_INSTALL : await promptForDependencyInstall(packageManager));
  if (shouldInstall === undefined) {
    return;
  }

  return {
    projectDir,
    verbose,
    shouldEmit,
    databaseProvider,
    authoring,
    schemaPreset,
    databaseUrl,
    shouldUsePrismaPostgres,
    packageManager,
    shouldInstall,
  };
}

function getDefaultDatabaseUrl(provider: DatabaseProvider): string {
  switch (provider) {
    case "postgres":
      return "postgresql://user:password@localhost:5432/mydb";
    case "mongo":
      return "mongodb://localhost:27017/mydb?replicaSet=rs0&directConnection=true";
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported Prisma Next target: ${String(exhaustiveCheck)}`);
    }
  }
}

// Escape regex metacharacters before interpolating dynamic values into RegExp.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("Environment variable values must be single-line.");
  }

  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function hasEnvVar(content: string, envVarName: string): boolean {
  const escapedName = escapeRegExp(envVarName);
  return new RegExp(`(^|\\n)\\s*${escapedName}\\s*=`).test(content);
}

function hasEnvComment(content: string, comment: string): boolean {
  const escapedComment = escapeRegExp(comment);
  return new RegExp(`(^|\\n)\\s*#\\s*${escapedComment}\\s*(?=\\n|$)`).test(content);
}

async function ensureEnvVarInEnv(
  projectDir: string,
  envVarName: string,
  envVarValue: string,
  opts: {
    mode: EnvWriteMode;
    comment?: string;
  },
): Promise<void> {
  const envPath = path.join(projectDir, ".env");
  const envLine = `${envVarName}="${escapeEnvValue(envVarValue)}"`;

  if (!(await fs.pathExists(envPath))) {
    const content = opts.comment ? `# ${opts.comment}\n${envLine}\n` : `${envLine}\n`;
    await fs.writeFile(envPath, content, "utf8");
    return;
  }

  const existingContent = await fs.readFile(envPath, "utf8");
  if (hasEnvVar(existingContent, envVarName)) {
    if (opts.mode === "keep-existing") {
      return;
    }

    const escapedName = escapeRegExp(envVarName);
    const lineRegex = new RegExp(`(^|\\n)\\s*${escapedName}\\s*=.*(?=\\n|$)`, "gm");
    const updatedContent = existingContent.replace(lineRegex, `$1${envLine}`);
    if (updatedContent === existingContent) {
      return;
    }

    await fs.writeFile(envPath, updatedContent, "utf8");
    return;
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  const commentLine = opts.comment ? `\n# ${opts.comment}\n` : "\n";
  const insertion = `${separator}${commentLine}${envLine}\n`;
  await fs.appendFile(envPath, insertion, "utf8");
}

async function ensureEnvComment(projectDir: string, comment: string): Promise<void> {
  const envPath = path.join(projectDir, ".env");
  const commentLine = `# ${comment}`;

  if (!(await fs.pathExists(envPath))) {
    await fs.writeFile(envPath, `${commentLine}\n`, "utf8");
    return;
  }

  const existingContent = await fs.readFile(envPath, "utf8");
  if (hasEnvComment(existingContent, comment)) {
    return;
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  await fs.appendFile(envPath, `${separator}${commentLine}\n`, "utf8");
}

function hasGitignoreEntry(content: string, entry: string): boolean {
  const escapedEntry = escapeRegExp(entry);
  const escapedWithLeadingSlash = escapeRegExp(`/${entry}`);
  const escapedWithTrailingSlash = escapeRegExp(`${entry}/`);
  const escapedWithLeadingAndTrailingSlash = escapeRegExp(`/${entry}/`);
  return new RegExp(
    `(^|\\n)\\s*(?:${escapedEntry}|${escapedWithLeadingSlash}|${escapedWithTrailingSlash}|${escapedWithLeadingAndTrailingSlash})\\s*(?=\\n|$)`,
  ).test(content);
}

async function ensureGitignoreEntry(projectDir: string, entry: string): Promise<void> {
  const gitignorePath = path.join(projectDir, ".gitignore");

  if (!(await fs.pathExists(gitignorePath))) {
    await fs.writeFile(gitignorePath, `${entry}\n`, "utf8");
    return;
  }

  const existingContent = await fs.readFile(gitignorePath, "utf8");
  if (hasGitignoreEntry(existingContent, entry)) {
    return;
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  await fs.appendFile(gitignorePath, `${separator}${entry}\n`, "utf8");
}

async function ensurePackageScripts(
  projectDir: string,
  scripts: Record<string, string>,
): Promise<void> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return;
  }

  const packageJson = await fs.readJson(packageJsonPath);
  if (!packageJson.scripts) {
    packageJson.scripts = {};
  }

  let didChange = false;
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (
      typeof packageJson.scripts[scriptName] !== "string" ||
      packageJson.scripts[scriptName].trim().length === 0
    ) {
      packageJson.scripts[scriptName] = command;
      didChange = true;
    }
  }

  if (didChange) {
    await fs.writeJson(packageJsonPath, packageJson, {
      spaces: 2,
    });
  }
}

async function ensureMongoDockerCompose(projectDir: string): Promise<void> {
  const composePath = path.join(projectDir, "docker-compose.yml");
  if (await fs.pathExists(composePath)) {
    return;
  }

  await fs.writeFile(composePath, MONGO_DOCKER_COMPOSE, "utf8");
}

async function writeMongoDockerHelpersForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  if (context.databaseProvider !== "mongo" || context.databaseUrl) {
    return true;
  }

  try {
    await ensureMongoDockerCompose(projectDir);
    await ensurePackageScripts(projectDir, mongoDockerScripts);
    return true;
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

async function ensureRequiredPrismaFiles(projectDir: string): Promise<void> {
  const missingFiles: string[] = [];

  for (const candidates of requiredPrismaFileGroups) {
    let foundCandidate = false;

    for (const relativePath of candidates) {
      const absolutePath = path.join(projectDir, relativePath);
      if (await fs.pathExists(absolutePath)) {
        foundCandidate = true;
        break;
      }
    }

    if (!foundCandidate) {
      missingFiles.push(candidates.join(" or "));
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(`Template is missing required Prisma Next files: ${missingFiles.join(", ")}`);
  }
}

async function finalizePrismaFiles(options: FinalizePrismaOptions): Promise<void> {
  const projectDir = options.projectDir ?? process.cwd();
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);

  await ensureRequiredPrismaFiles(projectDir);

  const databaseUrl = options.databaseUrl ?? getDefaultDatabaseUrl(options.provider);
  await ensureEnvVarInEnv(prismaProjectDir, "DATABASE_URL", databaseUrl, {
    mode: options.databaseUrl ? "upsert" : "keep-existing",
    comment: "Added by create-prisma",
  });

  if (options.claimUrl) {
    await ensureEnvVarInEnv(prismaProjectDir, "CLAIM_URL", options.claimUrl, {
      mode: "upsert",
      comment: PRISMA_POSTGRES_TEMPORARY_NOTICE,
    });
    await ensureEnvComment(prismaProjectDir, PRISMA_POSTGRES_TEMPORARY_NOTICE);
  }

  await ensureGitignoreEntry(prismaProjectDir, ".env");
}

async function provisionPrismaPostgresIfNeeded(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<PrismaPostgresProvisionResult | undefined> {
  if (!context.shouldUsePrismaPostgres) {
    return {
      databaseUrl: context.databaseUrl,
    };
  }

  const createDbCommand = getCreateDbCommand(context.packageManager);
  const prismaPostgresSpinner = spinner();
  prismaPostgresSpinner.start(`Provisioning Prisma Postgres with ${createDbCommand}...`);

  try {
    const prismaPostgresResult = await provisionPrismaPostgres(context.packageManager, projectDir);

    prismaPostgresSpinner.stop("Prisma Postgres database provisioned.");
    return {
      databaseUrl: prismaPostgresResult.databaseUrl,
      claimUrl: prismaPostgresResult.claimUrl,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    prismaPostgresSpinner.stop("Could not provision Prisma Postgres.");

    return {
      databaseUrl: context.databaseUrl,
      warning: `Prisma Postgres provisioning failed: ${errorMessage}`,
    };
  }
}

async function writeDependenciesForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  try {
    await writePrismaDependencies(
      context.databaseProvider,
      context.packageManager,
      context.authoring,
      prismaProjectDir,
    );
    return true;
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

async function installDependenciesForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  if (!context.shouldInstall) {
    return true;
  }

  const installCommand = getInstallCommand(context.packageManager);
  if (context.verbose) {
    log.step(`Running ${installCommand}`);
    try {
      await installProjectDependencies(context.packageManager, projectDir, {
        verbose: context.verbose,
      });
      log.success("Dependencies installed.");
      return true;
    } catch (error) {
      cancel(`Failed to run ${installCommand}: ${getCommandErrorMessage(error)}`);
      return false;
    }
  }

  const installSpinner = spinner();
  installSpinner.start(`Running ${installCommand}...`);
  try {
    await installProjectDependencies(context.packageManager, projectDir, {
      verbose: context.verbose,
    });
    installSpinner.stop("Dependencies installed.");
    return true;
  } catch (error) {
    installSpinner.stop("Could not install dependencies.");
    cancel(`Failed to run ${installCommand}: ${getCommandErrorMessage(error)}`);
    return false;
  }
}

async function finalizePrismaFilesForContext(
  context: PrismaSetupContext,
  projectDir: string,
  provisionResult: PrismaPostgresProvisionResult,
): Promise<boolean> {
  const initSpinner = spinner();
  initSpinner.start("Preparing Prisma Next files...");

  try {
    await finalizePrismaFiles({
      provider: context.databaseProvider,
      databaseUrl: provisionResult.databaseUrl,
      claimUrl: provisionResult.claimUrl,
      projectDir,
    });

    initSpinner.stop("Prisma Next files ready.");
    return true;
  } catch (error) {
    initSpinner.stop("Could not prepare Prisma Next files.");
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

async function writePrismaNextProjectDocsForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<boolean> {
  try {
    await writePrismaNextProjectDocs({
      provider: context.databaseProvider,
      authoring: context.authoring,
      schemaPreset: context.schemaPreset,
      packageManager: context.packageManager,
      projectDir,
    });
    return true;
  } catch (error) {
    cancel(getCommandErrorMessage(error));
    return false;
  }
}

function getPrismaNextCliCommand(packageManager: PackageManager, prismaNextArgs: string[]): string {
  if (packageManager === "deno") {
    return `deno run -A --env-file=.env npm:prisma-next@${dependencyVersionMap["prisma-next"]} ${prismaNextArgs.join(" ")}`;
  }

  return getLocalPackageBinaryCommand(packageManager, "prisma-next", prismaNextArgs);
}

function getPrismaNextCliArgs(
  packageManager: PackageManager,
  prismaNextArgs: string[],
): { command: string; args: string[] } {
  if (packageManager === "deno") {
    return {
      command: "deno",
      args: [
        "run",
        "-A",
        "--env-file=.env",
        `npm:prisma-next@${dependencyVersionMap["prisma-next"]}`,
        ...prismaNextArgs,
      ],
    };
  }

  return getLocalPackageBinaryArgs(packageManager, "prisma-next", prismaNextArgs);
}

async function emitPrismaNextContractForContext(
  context: PrismaSetupContext,
  projectDir: string,
): Promise<PrismaNextEmitResult> {
  const prismaProjectDir = await resolvePrismaProjectDir(projectDir);
  if (!context.shouldEmit) {
    return {
      didEmitContract: false,
    };
  }
  if (!context.shouldInstall) {
    return {
      didEmitContract: false,
      warning: "Skipped contract emit because dependencies were not installed.",
    };
  }

  const emitCommand = getPrismaNextCliCommand(context.packageManager, ["contract", "emit"]);
  if (context.verbose) {
    log.step(`Running ${emitCommand}`);
  }

  const emitSpinner = context.verbose ? undefined : spinner();
  emitSpinner?.start("Emitting Prisma Next contract...");
  try {
    const emitArgs = getPrismaNextCliArgs(context.packageManager, ["contract", "emit"]);
    await execa(emitArgs.command, emitArgs.args, {
      cwd: prismaProjectDir,
      stdio: context.verbose ? "inherit" : "pipe",
    });
    if (context.verbose) {
      log.success("Prisma Next contract emitted.");
    } else {
      emitSpinner?.stop("Prisma Next contract emitted.");
    }

    return {
      didEmitContract: true,
    };
  } catch (error) {
    if (context.verbose) {
      log.warn("Could not emit Prisma Next contract.");
    } else {
      emitSpinner?.stop("Could not emit Prisma Next contract.");
    }

    return {
      didEmitContract: false,
      warning: `Contract emit failed: ${getCommandErrorMessage(error)}`,
    };
  }
}

function buildWarningLines(
  provisionWarning: string | undefined,
  emitWarning: string | undefined,
): string[] {
  const warningLines: string[] = [];

  if (provisionWarning) {
    warningLines.push(`- ${provisionWarning}`);
  }
  if (emitWarning) {
    warningLines.push(`- ${emitWarning}`);
  }

  return warningLines;
}

function buildNextStepsForContext(opts: {
  context: PrismaSetupContext;
  options: PrismaSetupRunOptions;
  didEmitContract: boolean;
}): NextStep[] {
  const { context, options, didEmitContract } = opts;
  const nextSteps: NextStep[] = [...(options.prependNextSteps ?? [])];

  if (!context.shouldInstall) {
    nextSteps.push({
      command: getInstallCommand(context.packageManager),
      description: "Install the project dependencies.",
    });
  }
  if (!didEmitContract || !context.shouldEmit) {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "contract:emit"),
      description: "Emit contract.json and TypeScript types from your Prisma Next contract.",
    });
  }
  if (context.databaseProvider === "postgres") {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "db:init"),
      description: "Create the initial PostgreSQL database objects and sign the database.",
    });
  }
  if (context.databaseProvider === "mongo" && !context.databaseUrl) {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "db:up"),
      description: "Start the local MongoDB replica set with Docker.",
    });
  }
  nextSteps.push({
    command: getRunScriptCommand(context.packageManager, "migration:plan"),
    description: "Compare the contract to the database and write a migration plan.",
  });
  nextSteps.push({
    command: getRunScriptCommand(context.packageManager, "migration:apply"),
    description: "Apply the planned migration to the database.",
  });
  if (context.schemaPreset === "basic") {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "db:seed"),
      description: "Insert the sample user and post data from prisma/seed.ts.",
    });
  }
  if (options.includeDevNextStep) {
    nextSteps.push({
      command: getRunScriptCommand(context.packageManager, "dev"),
      description: "Start the development server.",
    });
  }

  return nextSteps;
}

function formatNextSteps(nextSteps: NextStep[]): string {
  return nextSteps.map((step) => `${step.command}\n  ${step.description}`).join("\n\n");
}

export async function executePrismaSetupContext(
  context: PrismaSetupContext,
  options: PrismaSetupRunOptions = {},
): Promise<boolean> {
  const projectDir = path.resolve(options.projectDir ?? context.projectDir);
  const provisionResult = await provisionPrismaPostgresIfNeeded(context, projectDir);
  if (!provisionResult) {
    return false;
  }

  const didWriteDependencies = await writeDependenciesForContext(context, projectDir);
  if (!didWriteDependencies) {
    return false;
  }

  const dependenciesInstalled = await installDependenciesForContext(context, projectDir);
  if (!dependenciesInstalled) {
    return false;
  }

  const didFinalizePrismaFiles = await finalizePrismaFilesForContext(
    context,
    projectDir,
    provisionResult,
  );
  if (!didFinalizePrismaFiles) {
    return false;
  }

  const didWriteMongoDockerHelpers = await writeMongoDockerHelpersForContext(context, projectDir);
  if (!didWriteMongoDockerHelpers) {
    return false;
  }

  const didWriteProjectDocs = await writePrismaNextProjectDocsForContext(context, projectDir);
  if (!didWriteProjectDocs) {
    return false;
  }

  const emitResult = await emitPrismaNextContractForContext(context, projectDir);

  const warningLines = buildWarningLines(provisionResult.warning, emitResult.warning);
  const nextSteps = buildNextStepsForContext({
    context,
    options,
    didEmitContract: emitResult.didEmitContract,
  });

  if (warningLines.length > 0) {
    note(warningLines.map((line) => line.replace(/^- /, "")).join("\n"), "Heads up");
  }

  note(formatNextSteps(nextSteps), "Next steps");
  outro("Setup complete.");

  return true;
}
