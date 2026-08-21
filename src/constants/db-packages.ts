import type { DatabaseProvider } from "../types";

export function getDbPackages(provider: DatabaseProvider): string {
  switch (provider) {
    case "postgres":
      return "@prisma/orm-postgres";
    case "mongo":
      return "@prisma/orm-mongo";
  }
}
