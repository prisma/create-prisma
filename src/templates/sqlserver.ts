export function generateDbTs(envVar: string): string {
	return `
import "dotenv/config"
import { PrismaMssql } from "@prisma/adapter-mssql";
import { PrismaClient } from "../generated/prisma/client";

declare global {
	var prisma: PrismaClient | undefined;
}

const sqlConfig = {
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	server: process.env.HOST,
	pool: {
		max: 10,
		min: 0,
		idleTimeoutMillis: 30000
	},
	options: {
		encrypt: true, // for azure
		trustServerCertificate: false // change to true for local dev / self-signed certs
	}
}
const adapter = new PrismaMssql(sqlConfig)

export const prisma: PrismaClient = globalThis.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;
export default prisma;
`.trimStart();
}


