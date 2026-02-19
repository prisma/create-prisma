import { runCommand } from "../utils/exec.js";

export async function prismaInit(provider: string): Promise<void> {
	await runCommand("npx", ["-y", "prisma", "init", "--datasource-provider", provider]);
}


