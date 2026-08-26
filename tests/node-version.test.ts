import { describe, expect, test } from "bun:test";

import { getUnsupportedNodeMessage, supportsPrisma } from "../src/utils/node-version";

describe("Prisma 8 Node compatibility", () => {
  test("requires Node 22.18 or newer", () => {
    expect(supportsPrisma("22.17.9")).toBe(false);
    expect(supportsPrisma("22.18.0")).toBe(true);
    expect(supportsPrisma("24.0.0")).toBe(true);
  });

  test("returns an actionable message", () => {
    expect(getUnsupportedNodeMessage("20.19.0")).toContain("Required: Node.js 22.18 or newer.");
  });
});
