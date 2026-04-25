import type { DatabaseProvider, PackageManager } from "../types";

export function getDbPackages(provider: DatabaseProvider, packageManager?: PackageManager): string {
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      return "@prisma/adapter-pg";
    case "mysql":
      return "@prisma/adapter-mariadb";
    case "sqlite":
      if (packageManager === "deno") {
        return "@prisma/adapter-libsql";
      }
      return "@prisma/adapter-better-sqlite3";
    case "sqlserver":
      return "@prisma/adapter-mssql";
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported database provider: ${String(exhaustiveCheck)}`);
    }
  }
}
