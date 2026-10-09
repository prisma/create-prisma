import { describe, expect, test } from "bun:test";

import {
  getUnsupportedNodeMessage,
  MINIMUM_NODE_VERSION,
  supportsPrisma,
} from "../src/utils/node-version";
import { npmForMinimumNode } from "../src/utils/package-manager";

describe("Prisma 8 Node compatibility", () => {
  test("requires Node 22.18 or newer", () => {
    expect(supportsPrisma("22.17.9")).toBe(false);
    expect(supportsPrisma("22.18.0")).toBe(true);
    expect(supportsPrisma("22.20.0")).toBe(true);
    expect(supportsPrisma("24.0.0")).toBe(true);
  });

  test("returns an actionable message", () => {
    expect(getUnsupportedNodeMessage("20.19.0")).toContain("Required: Node.js 22.18 or newer.");
  });

  test("pairs the npm fallback for generated projects with the minimum Node.js version", () => {
    expect(npmForMinimumNode.node).toEqual(MINIMUM_NODE_VERSION);
  });
});
