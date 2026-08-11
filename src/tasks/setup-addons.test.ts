import { describe, expect, test } from "bun:test";

import { collectCreateAddonSetupContext } from "./setup-addons";

describe("recommended Prisma skills", () => {
  test("does not recommend the Compute skill for Composer projects", async () => {
    const context = await collectCreateAddonSetupContext(
      { skills: true },
      {
        useDefaults: true,
        provider: "mysql",
        shouldUsePrismaPostgres: false,
      },
    );

    expect(context?.skills).toEqual([
      "prisma-cli",
      "prisma-client-api",
      "prisma-database-setup",
      "prisma-upgrade-v7",
    ]);
  });

  test("still recommends the Prisma Postgres skill for Prisma Postgres", async () => {
    const context = await collectCreateAddonSetupContext(
      { skills: true },
      {
        useDefaults: true,
        provider: "postgresql",
        shouldUsePrismaPostgres: true,
      },
    );

    expect(context?.skills).toContain("prisma-postgres");
    expect(context?.skills).not.toContain("prisma-compute");
  });
});
