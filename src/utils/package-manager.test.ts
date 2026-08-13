import { describe, expect, test } from "bun:test";

import { getPackageExecutionCommand, getPrismaCliCommand } from "./package-manager";

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

describe("package execution commands", () => {
  test.each([
    ["npm", "npx --yes @prisma/cli@next auth whoami"],
    ["pnpm", "pnpm --silent dlx @prisma/cli@next auth whoami"],
    ["yarn", "yarn dlx --quiet @prisma/cli@next auth whoami"],
    ["bun", "bunx --silent @prisma/cli@next auth whoami"],
  ] as const)("uses the native %s package runner", (packageManager, expected) => {
    const command = getPackageExecutionCommand(
      packageManager,
      ["@prisma/cli@next", "auth", "whoami"],
      { silent: true },
    );

    expect(command).toBe(expected);
    expect(command).not.toContain("--no-update-notifier");
  });
});
