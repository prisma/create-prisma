export const dependencyVersionMap = {
  "@prisma/client": "^7.4.0",
  "@prisma/adapter-pg": "^7.4.0",
  "@prisma/adapter-mariadb": "^7.4.0",
  "@prisma/adapter-better-sqlite3": "^7.4.0",
  "@prisma/adapter-mssql": "^7.4.0",
  dotenv: "^17.2.3",
  "node-gyp": "^11.5.0",
  prisma: "^7.4.0",
  tsx: "^4.7.1",
} as const;

export type AvailableDependency = keyof typeof dependencyVersionMap;
