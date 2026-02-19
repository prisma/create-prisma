import type { DatabaseProvider } from "../types.js";
import { writeTextFile } from "../utils/fs.js";
import * as pgTpl from "../templates/postgresql.js";
import * as cockroachTpl from "../templates/cockroachdb.js";
import * as mysqlTpl from "../templates/mysql.js";
import * as sqliteTpl from "../templates/sqlite.js";
import * as mssqlTpl from "../templates/sqlserver.js";
import path from "node:path";

export function generateDbContent(provider: DatabaseProvider, envVar = "DATABASE_URL"): string {
	switch (provider) {
		case "postgresql":
			return pgTpl.generateDbTs(envVar);
		case "cockroachdb":
			return cockroachTpl.generateDbTs(envVar);
		case "mysql":
			return mysqlTpl.generateDbTs(envVar);
		case "sqlite":
			return sqliteTpl.generateDbTs(envVar);
		case "sqlserver":
		default:
			return mssqlTpl.generateDbTs(envVar);
	}
}

export async function writeDbFile(dir: string, provider: DatabaseProvider): Promise<string> {
	const content = generateDbContent(provider, "DATABASE_URL");
	const targetDir = path.join(dir, "db");
	return await writeTextFile(targetDir, "index.ts", content);
}


