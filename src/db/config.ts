import type { DatabaseProvider } from "../types";

export type DbPackages = {
  adapterPackage: string;
};

export function getDbPackages(provider: DatabaseProvider): DbPackages {
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      return { adapterPackage: "@prisma/adapter-pg" };
    case "mysql":
      return { adapterPackage: "@prisma/adapter-mariadb" };
    case "sqlite":
      return { adapterPackage: "@prisma/adapter-better-sqlite3" };
    case "sqlserver":
      return { adapterPackage: "@prisma/adapter-mssql" };
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(
        `Unsupported database provider: ${String(exhaustiveCheck)}`
      );
    }
  }
}
