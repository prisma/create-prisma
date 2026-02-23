export const dependencyVersionMap = {
  "@prisma/client": "^7.4.0",
  "@prisma/adapter-pg": "^7.4.0",
  "@prisma/adapter-mariadb": "^7.4.0",
  "@prisma/adapter-better-sqlite3": "^7.4.0",
  "@prisma/adapter-mssql": "^7.4.0",
  dotenv: "^17.2.3",
  prisma: "^7.4.0",
} as const;

export type AvailableDependency = keyof typeof dependencyVersionMap;
