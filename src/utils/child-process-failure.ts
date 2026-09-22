import { Schema } from "effect";
import { statSync } from "node:fs";
import path from "node:path";

export const ChildProcessFailureSchema = Schema.Literals([
  "cancelled",
  "command_not_found",
  "interrupted",
  "max_buffer",
  "non_zero_exit",
  "permission_denied",
  "spawn_failed",
  "terminated",
  "timed_out",
]);
export type ChildProcessFailure = typeof ChildProcessFailureSchema.Type;

const WINDOWS_CONTROL_C_EXIT_CODE = 0xc000013a;

export function getChildProcessFailure(error: unknown): ChildProcessFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (Reflect.get(error, "name") !== "ExecaError" || Reflect.get(error, "failed") !== true) {
    return undefined;
  }

  if (Reflect.get(error, "timedOut") === true) return "timed_out";
  if (Reflect.get(error, "isCanceled") === true) return "cancelled";
  if (Reflect.get(error, "isMaxBuffer") === true) return "max_buffer";

  const exitCode = Reflect.get(error, "exitCode");
  const signal = Reflect.get(error, "signal");
  if (signal === "SIGINT" || exitCode === 130 || exitCode === WINDOWS_CONTROL_C_EXIT_CODE) {
    return "interrupted";
  }
  if (Reflect.get(error, "isTerminated") === true) return "terminated";

  const code = Reflect.get(error, "code");
  if (code === "ENOENT") return "command_not_found";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (typeof exitCode === "number") return "non_zero_exit";
  return "spawn_failed";
}

export type SpawnedCommand = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

// execa runs non-.exe Windows commands through cmd.exe, so a missing one exits non-zero instead
// of raising ENOENT.
function isCommandOnWindowsPath({ command, cwd, env }: SpawnedCommand): boolean {
  const environment = { ...process.env, ...env };
  const pathKey = Object.keys(environment)
    .reverse()
    .find((key) => key.toUpperCase() === "PATH");
  const directories = /[\\/]/.test(command)
    ? [""]
    : [cwd, ...(pathKey ? (environment[pathKey] ?? "") : "").split(";")];
  const extensions = ["", ...(environment.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")];
  return directories.some((directory) =>
    extensions.some((extension) =>
      isFile(path.resolve(cwd, directory.replace(/^"(.*)"$/, "$1"), command + extension)),
    ),
  );
}

export function getSpawnedCommandFailure(
  error: unknown,
  spawned: SpawnedCommand,
): ChildProcessFailure | undefined {
  const failure = getChildProcessFailure(error);
  return failure === "non_zero_exit" &&
    (spawned.platform ?? process.platform) === "win32" &&
    !isCommandOnWindowsPath(spawned)
    ? "command_not_found"
    : failure;
}
