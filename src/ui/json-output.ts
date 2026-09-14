import { Effect } from "effect";

import type { CreateCommandResult } from "../result";

export function isJsonOutputRequested(argv: readonly string[]): boolean {
  let requested = false;
  for (const [index, argument] of argv.entries()) {
    if (argument === "--json") requested = argv[index + 1]?.toLowerCase() !== "false";
    if (argument.startsWith("--json=")) {
      requested = argument.slice("--json=".length).toLowerCase() !== "false";
    }
    if (argument === "--no-json") requested = false;
  }
  return requested;
}

export const writeJsonResult = Effect.fn("JsonOutput.write")((result: CreateCommandResult) =>
  Effect.sync(() => process.stdout.write(`${JSON.stringify(result)}\n`)),
);
