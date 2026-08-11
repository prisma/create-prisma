import { describe, expect, test } from "bun:test";

import { getNodeVersionCompatibilityError, supportedNodeVersionRange } from "./node-version";

describe("Node.js compatibility", () => {
  test("uses the package engine range as its source of truth", () => {
    expect(supportedNodeVersionRange).toBe(">=24.0.0");
  });

  test.each(["24.0.0", "24.19.0", "26.7.0"])("accepts Node.js %s", (nodeVersion) => {
    expect(getNodeVersionCompatibilityError(nodeVersion)).toBeUndefined();
  });

  test("rejects an older Node.js version with an actionable message", () => {
    expect(getNodeVersionCompatibilityError("22.14.0")).toBe(
      [
        "Node.js 22.14.0 is unsupported.",
        "",
        "create-prisma requires Node.js 24 LTS or newer.",
        "Update Node.js, then run create-prisma again.",
      ].join("\n"),
    );
  });
});
