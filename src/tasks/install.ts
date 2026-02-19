import type { DatabaseProvider } from "../types.js";
import { getDbPackages } from "../db/config.js";
import { runCommand } from "../utils/exec.js";

export async function installPrismaAndDrivers(provider: DatabaseProvider): Promise<string[]> {
	await runCommand("npm", ["i", "-D", "prisma"]);
	const runtimePackages: string[] = ["@prisma/client", "dotenv"];
	const { adapterPackage } = getDbPackages(provider);
	if (adapterPackage) runtimePackages.push(adapterPackage);
	await runCommand("npm", ["i", ...runtimePackages]);
	return runtimePackages;
}


