import { describe, expect, test } from "bun:test";

import { getPrismaCliCommand } from "./package-manager";

describe("Prisma CLI commands", () => {
  test.each([
    ["npm", "npx prisma migrate deploy"],
    ["pnpm", "pnpm exec prisma migrate deploy"],
    ["yarn", "yarn exec prisma migrate deploy"],
    ["bun", "bunx --bun prisma migrate deploy"],
  ] as const)("uses the native %s command", (packageManager, expected) => {
    const command = getPrismaCliCommand(packageManager, ["migrate", "deploy"]);

    expect(command).toBe(expected);
    expect(command).not.toContain("./node_modules/.bin/prisma");
  });
});
