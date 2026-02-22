import type { CreateCommandInput } from "../types";
import { runInitCommand } from "./init";

// Backward-compatible alias while we transition to explicit `init` command naming.
export async function runCreateCommand(input: CreateCommandInput = {}): Promise<void> {
  await runInitCommand(input);
}
