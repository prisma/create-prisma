import { spawn } from "node:child_process";

export async function runCommand(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			stdio: "pipe",
			shell: process.platform === "win32"
		});
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
		});
		child.on("error", (error) => reject(error));
	});
}


