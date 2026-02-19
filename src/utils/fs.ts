import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

export async function writeTextFile(dir: string, filename: string, content: string): Promise<string> {
	await ensureDir(dir);
	const filePath = path.join(dir, filename);
	await writeFile(filePath, content, "utf8");
	return filePath;
}


