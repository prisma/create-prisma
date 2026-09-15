import { Schema } from "effect";

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
