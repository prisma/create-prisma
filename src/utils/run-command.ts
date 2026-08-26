import { execa } from "execa";

/**
 * Runs a setup command without allowing child output to corrupt structured CLI output.
 * Human verbose mode keeps native streaming; JSON mode always captures child output.
 */
export async function runSetupCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  verbose: boolean;
  json: boolean;
}): Promise<void> {
  const shouldInheritOutput = options.verbose && !options.json;
  await execa(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: shouldInheritOutput ? "inherit" : "pipe",
  });
}
