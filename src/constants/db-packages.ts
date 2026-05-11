import type { DatabaseProvider, PackageManager } from "../types";

export function getDbPackages(
  provider: DatabaseProvider,
  _packageManager?: PackageManager,
): string {
  switch (provider) {
    case "postgres":
      return "@prisma-next/postgres";
    case "mongo":
      return "@prisma-next/mongo";
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported Prisma Next target: ${String(exhaustiveCheck)}`);
    }
  }
}
