import { describe, expect, test } from "bun:test";

import { extractDeploymentUrl } from "../src/tasks/deploy-with-composer";

describe("extractDeploymentUrl", () => {
  test("returns the deployed Prisma Compute URL", () => {
    expect(
      extractDeploymentUrl(`
app       compute-service cps_abc123
          https://abc123.ewr.prisma.build
Done: 22 succeeded
`),
    ).toBe("https://abc123.ewr.prisma.build");
  });

  test("uses the final deployed URL and removes a trailing slash", () => {
    expect(
      extractDeploymentUrl(
        "Previous: https://old.ewr.prisma.build\nCurrent: https://new.fra.prisma.build/",
      ),
    ).toBe("https://new.fra.prisma.build");
  });

  test("returns undefined when deploy output has no Compute URL", () => {
    expect(extractDeploymentUrl("Done: 22 succeeded")).toBeUndefined();
  });
});
