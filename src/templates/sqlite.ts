export function generateDbTs(envVar: string): string {
	return `
import "dotenv/config"
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";

declare global {
	var prisma: PrismaClient | undefined;
}

const connectionString = \`\${process.env.${envVar}}\`;
const adapter = new PrismaBetterSqlite3({ url: connectionString });

export const prisma: PrismaClient = globalThis.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;
export default prisma;
`.trimStart();
}


