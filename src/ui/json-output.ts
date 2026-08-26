import type { Logger } from "trpc-cli";

import { createCommandFailureResult, type CreateCommandResult } from "../result";

function isCreateCommandResult(value: unknown): value is CreateCommandResult {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "schemaVersion") === 1 && typeof Reflect.get(value, "ok") === "boolean";
}

function formatLoggerMessage(values: unknown[]): string {
  return values
    .map((value) => {
      if (value instanceof Error) return value.message;
      if (typeof value === "string") return value.trim();
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .filter(Boolean)
    .join(" ");
}

export function isJsonOutputRequested(argv: string[]): boolean {
  let requested = false;
  for (const [index, argument] of argv.entries()) {
    if (argument === "--json") {
      requested = argv[index + 1]?.toLowerCase() !== "false";
    }
    if (argument.startsWith("--json=")) {
      requested = argument.slice("--json=".length).toLowerCase() !== "false";
    }
    if (argument === "--no-json") requested = false;
  }
  return requested;
}

export function createJsonOutputLogger(
  write: (output: string) => void = (output) => process.stdout.write(output),
): Logger {
  let didWrite = false;
  const writeResult = (result: CreateCommandResult) => {
    if (didWrite) return;
    didWrite = true;
    write(`${JSON.stringify(result)}\n`);
  };

  return {
    info(...values: unknown[]) {
      const result = values.length === 1 ? values[0] : undefined;
      if (isCreateCommandResult(result)) {
        writeResult(result);
        return;
      }

      writeResult(
        createCommandFailureResult(
          "parse_arguments",
          formatLoggerMessage(values) || "The CLI returned an unexpected result.",
        ),
      );
    },
    error(...values: unknown[]) {
      writeResult(
        createCommandFailureResult(
          "parse_arguments",
          formatLoggerMessage(values) || "Could not parse command arguments.",
        ),
      );
    },
  };
}
