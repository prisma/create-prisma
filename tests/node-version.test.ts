import { describe, expect, test } from "bun:test";

import { getUnsupportedNodeMessage, supportsPrisma } from "../src/utils/node-version";

describe("Prisma 8 Node compatibility", () => {
  test("requires Node 22.22 or newer", () => {
    expect(supportsPrisma("22.21.9")).toBe(false);
    expect(supportsPrisma("22.22.0")).toBe(true);
    expect(supportsPrisma("24.0.0")).toBe(true);
  });

  test("returns an actionable message", () => {
    expect(getUnsupportedNodeMessage("20.19.0")).toContain("Required: Node.js 22.22 or newer.");
  });
});
