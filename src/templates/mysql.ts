export function generateDbTs(envVar: string): string {
	return `
import "dotenv/config"
import { PrismaClient } from "../generated/prisma/client";
import { PrismaMariaDB } from "@prisma/adapter-mariadb";

declare global {
	var prisma: PrismaClient | undefined;
}

const adapter = new PrismaMariaDB({
	host: process.env.DATABASE_HOST,
	user: process.env.DATABASE_USER,
	password: process.env.DATABASE_PASSWORD,
	database: process.env.DATABASE_NAME,
	connectionLimit: 5
});

export const prisma: PrismaClient = globalThis.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;
export default prisma;
`.trimStart();
}


