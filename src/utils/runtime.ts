import type { PackageManager } from "../types";

export function usesNodeStyleRuntime(packageManager: PackageManager | undefined): boolean {
  return packageManager !== undefined && packageManager !== "bun" && packageManager !== "deno";
}

export function requiresDotenvConfigImport(packageManager: PackageManager | undefined): boolean {
  return usesNodeStyleRuntime(packageManager);
}
