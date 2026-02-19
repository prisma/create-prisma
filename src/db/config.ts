import { DatabaseProvider } from "../types.js";

export type DbPackages = {
	adapterPackage: string | null;
};

export function getDbPackages(provider: DatabaseProvider): DbPackages {
	switch (provider) {
		case "postgresql":
		case "cockroachdb":
			return { adapterPackage: "@prisma/adapter-pg" };
		case "mysql":
			return { adapterPackage: "@prisma/adapter-mariadb" };
		case "sqlite":
			return { adapterPackage: "@prisma/adapter-better-sqlite3"};
		case "sqlserver":
			return { adapterPackage: "@prisma/adapter-mssql" };
		default:
			return { adapterPackage: null };
	}
}


