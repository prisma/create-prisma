import { describe, expect, test } from "bun:test";

import { dependencyVersionMap, getDependencyVersion } from "../src/constants/dependencies";

describe("Prisma 8 dependency versions", () => {
  test("uses the aligned Prisma 8 and Composer releases", () => {
    expect(getDependencyVersion("prisma-next")).toBe("8.0.0-rc.1");
    expect(getDependencyVersion("@prisma/orm-postgres")).toBe("8.0.0-rc.1");
    expect(getDependencyVersion("@prisma/cli")).toBe("8.0.0-rc.2");
    expect(getDependencyVersion("@prisma/cli-engine")).toBe("8.0.0-rc.2");
    expect(getDependencyVersion("@prisma/composer")).toBe("0.7.0");
    expect(getDependencyVersion("@prisma/composer-prisma-cloud")).toBe("0.7.0");
  });

  test("returns undefined for dependencies missing from the version map", () => {
    expect(getDependencyVersion("not-a-package")).toBeUndefined();
    expect(dependencyVersionMap.esbuild).toMatch(/^\^/);
  });
});
