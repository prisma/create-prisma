import type { CreateTemplate, PackageManager } from "../types";

export const dependencyVersionMap = {
  "@elysiajs/node": "^1.4.5",
  "@prisma/client": "^7.4.0",
  "@prisma/adapter-pg": "^7.4.0",
  "@prisma/adapter-mariadb": "^7.4.0",
  "@prisma/adapter-better-sqlite3": "^7.4.0",
  "@prisma/adapter-mssql": "^7.4.0",
  "@types/node": "^24.3.0",
  dotenv: "^17.2.3",
  "node-gyp": "^11.5.0",
  prisma: "^7.4.0",
  tsx: "^4.21.0",
} as const;

export type AvailableDependency = keyof typeof dependencyVersionMap;

export function getCreateTemplateDependencies(
  template: CreateTemplate,
  packageManager: PackageManager,
): {
  dependencies: AvailableDependency[];
  devDependencies: AvailableDependency[];
} {
  if (template === "elysia" && packageManager !== "deno") {
    return {
      dependencies: ["@elysiajs/node"],
      devDependencies: ["@types/node"],
    };
  }

  return {
    dependencies: [],
    devDependencies: [],
  };
}
