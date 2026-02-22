import fs from "fs-extra";
import path from "node:path";

import { scaffoldInitTemplates } from "../templates/render-init-templates";
import type { DatabaseProvider } from "../types";

export type EnvStatus = "created" | "appended" | "existing" | "updated";
type EnvWriteMode = "keep-existing" | "upsert";

export type InitPrismaOptions = {
  provider: DatabaseProvider;
  databaseUrl?: string;
  claimUrl?: string;
  projectDir?: string;
};

export type InitPrismaResult = {
  schemaPath: string;
  configPath: string;
  singletonPath: string;
  envPath: string;
  envStatus: EnvStatus;
  claimEnvStatus?: EnvStatus;
};

function assertPrismaNotInitialized(projectDir: string): void {
  const rootSchemaPath = path.join(projectDir, "schema.prisma");
  const prismaSchemaPath = path.join(projectDir, "prisma", "schema.prisma");
  const prismaIndexPath = path.join(projectDir, "prisma", "index.ts");
  const prismaConfigPath = path.join(projectDir, "prisma.config.ts");

  if (fs.existsSync(rootSchemaPath)) {
    throw new Error(
      `File ${rootSchemaPath} already exists. This project already appears to be Prisma-initialized.`
    );
  }

  if (fs.existsSync(prismaSchemaPath)) {
    throw new Error(
      `File ${prismaSchemaPath} already exists. This project already appears to be Prisma-initialized.`
    );
  }

  if (fs.existsSync(prismaIndexPath)) {
    throw new Error(
      `File ${prismaIndexPath} already exists. This project already appears to be Prisma-initialized.`
    );
  }

  if (fs.existsSync(prismaConfigPath)) {
    throw new Error(
      `File ${prismaConfigPath} already exists. This project already appears to be Prisma-initialized.`
    );
  }
}

export function getDefaultDatabaseUrl(provider: DatabaseProvider): string {
  switch (provider) {
    case "postgresql":
      return "postgresql://johndoe:randompassword@localhost:5432/mydb?schema=public";
    case "cockroachdb":
      return "postgresql://johndoe:randompassword@localhost:26257/mydb?schema=public";
    case "mysql":
      return "mysql://johndoe:randompassword@localhost:3306/mydb";
    case "sqlite":
      return "file:./dev.db";
    case "sqlserver":
      return "sqlserver://localhost:1433;database=mydb;user=SA;password=randompassword;";
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported provider: ${String(exhaustiveCheck)}`);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasEnvVar(content: string, envVarName: string): boolean {
  const escapedName = escapeRegExp(envVarName);
  return new RegExp(`(^|\\n)\\s*${escapedName}\\s*=`).test(content);
}

async function ensureEnvVarInEnv(
  projectDir: string,
  envVarName: string,
  envVarValue: string,
  opts: {
    mode: EnvWriteMode;
    comment?: string;
  }
): Promise<{ envPath: string; status: EnvStatus }> {
  const envPath = path.join(projectDir, ".env");
  const envLine = `${envVarName}="${envVarValue}"`;

  if (!(await fs.pathExists(envPath))) {
    await fs.writeFile(envPath, `${envLine}\n`, "utf8");
    return { envPath, status: "created" };
  }

  const existingContent = await fs.readFile(envPath, "utf8");
  if (hasEnvVar(existingContent, envVarName)) {
    if (opts.mode === "keep-existing") {
      return { envPath, status: "existing" };
    }

    const escapedName = escapeRegExp(envVarName);
    const lineRegex = new RegExp(
      `(^|\\n)\\s*${escapedName}\\s*=.*(?=\\n|$)`,
      "m"
    );
    const updatedContent = existingContent.replace(lineRegex, `$1${envLine}`);
    if (updatedContent === existingContent) {
      return { envPath, status: "existing" };
    }

    await fs.writeFile(envPath, updatedContent, "utf8");
    return { envPath, status: "updated" };
  }

  const separator = existingContent.endsWith("\n") ? "" : "\n";
  const commentLine = opts.comment ? `\n# ${opts.comment}\n` : "\n";
  const insertion = `${separator}${commentLine}${envLine}\n`;
  await fs.appendFile(envPath, insertion, "utf8");

  return { envPath, status: "appended" };
}

export async function initializePrismaFiles(
  options: InitPrismaOptions
): Promise<InitPrismaResult> {
  const projectDir = options.projectDir ?? process.cwd();
  assertPrismaNotInitialized(projectDir);

  const scaffoldedPaths = await scaffoldInitTemplates(
    projectDir,
    options.provider
  );

  const databaseUrl =
    options.databaseUrl ?? getDefaultDatabaseUrl(options.provider);
  const envResult = await ensureEnvVarInEnv(
    projectDir,
    "DATABASE_URL",
    databaseUrl,
    {
      mode: options.databaseUrl ? "upsert" : "keep-existing",
      comment: "Added by create-prisma init",
    }
  );

  let claimEnvStatus: EnvStatus | undefined;
  if (options.claimUrl) {
    const claimResult = await ensureEnvVarInEnv(
      projectDir,
      "CLAIM_URL",
      options.claimUrl,
      {
        mode: "upsert",
        comment: "Added by create-prisma init",
      }
    );
    claimEnvStatus = claimResult.status;
  }

  return {
    schemaPath: scaffoldedPaths.schemaPath,
    configPath: scaffoldedPaths.configPath,
    singletonPath: scaffoldedPaths.singletonPath,
    envPath: envResult.envPath,
    envStatus: envResult.status,
    claimEnvStatus,
  };
}
