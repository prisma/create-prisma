export function generateDbTs(envVar: string): string {
	return `
import "dotenv/config"
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

declare global {
	var prisma: PrismaClient | undefined;
}

const adapter = new PrismaPg({ connectionString: process.env.${envVar} });

export const prisma: PrismaClient = globalThis.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;
export default prisma;
`.trimStart();
}


