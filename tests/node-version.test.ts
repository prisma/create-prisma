import { describe, expect, test } from "bun:test";

import { getUnsupportedNodeMessage, supportsPrismaNext } from "../src/utils/node-version";

describe("Prisma Next Node compatibility", () => {
  test("requires Node 22.18 or newer", () => {
    expect(supportsPrismaNext("22.17.9")).toBe(false);
    expect(supportsPrismaNext("22.18.0")).toBe(true);
    expect(supportsPrismaNext("24.0.0")).toBe(true);
  });

  test("returns an actionable message", () => {
    expect(getUnsupportedNodeMessage("20.19.0")).toContain("Required: Node.js 22.18 or newer.");
  });
});
