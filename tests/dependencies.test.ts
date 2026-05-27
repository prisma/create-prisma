import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PRISMA_NEXT_SPEC,
  getDependencyVersion,
  getPrismaNextPackageSpecifier,
  isPrismaNextPackage,
  parsePrismaNextVersionSpec,
  PRISMA_NEXT_DEFAULT_VERSION,
} from "../src/constants/dependencies";

describe("parsePrismaNextVersionSpec", () => {
  test("defaults to the npm `latest` dist-tag when input is omitted", () => {
    expect(parsePrismaNextVersionSpec(undefined)).toEqual(DEFAULT_PRISMA_NEXT_SPEC);
    expect(DEFAULT_PRISMA_NEXT_SPEC).toEqual({ kind: "npm", spec: PRISMA_NEXT_DEFAULT_VERSION });
  });

  test("treats blank input as the default", () => {
    expect(parsePrismaNextVersionSpec("")).toEqual(DEFAULT_PRISMA_NEXT_SPEC);
    expect(parsePrismaNextVersionSpec("   ")).toEqual(DEFAULT_PRISMA_NEXT_SPEC);
  });

  test("passes through published versions verbatim", () => {
    expect(parsePrismaNextVersionSpec("0.10.0")).toEqual({ kind: "npm", spec: "0.10.0" });
    expect(parsePrismaNextVersionSpec("0.11.0-dev.9")).toEqual({
      kind: "npm",
      spec: "0.11.0-dev.9",
    });
  });

  test("passes through npm dist-tags verbatim", () => {
    expect(parsePrismaNextVersionSpec("dev")).toEqual({ kind: "npm", spec: "dev" });
    expect(parsePrismaNextVersionSpec("next")).toEqual({ kind: "npm", spec: "next" });
    expect(parsePrismaNextVersionSpec("latest")).toEqual({ kind: "npm", spec: "latest" });
  });

  test("extracts a pkg.pr.new ref from the pkg-pr-new: prefix", () => {
    expect(parsePrismaNextVersionSpec("pkg-pr-new:bad6795")).toEqual({
      kind: "pkg-pr-new",
      ref: "bad6795",
    });
    expect(parsePrismaNextVersionSpec("pkg-pr-new:aman/some-branch")).toEqual({
      kind: "pkg-pr-new",
      ref: "aman/some-branch",
    });
    expect(parsePrismaNextVersionSpec("pkg-pr-new:581")).toEqual({
      kind: "pkg-pr-new",
      ref: "581",
    });
  });

  test("rejects an empty pkg-pr-new ref", () => {
    expect(() => parsePrismaNextVersionSpec("pkg-pr-new:")).toThrow(/pkg-pr-new:/);
    expect(() => parsePrismaNextVersionSpec("pkg-pr-new:   ")).toThrow(/pkg-pr-new:/);
  });
});

describe("isPrismaNextPackage", () => {
  test("matches prisma-next and @prisma-next/* scoped packages", () => {
    expect(isPrismaNextPackage("prisma-next")).toBe(true);
    expect(isPrismaNextPackage("@prisma-next/cli")).toBe(true);
    expect(isPrismaNextPackage("@prisma-next/vite-plugin-contract-emit")).toBe(true);
  });

  test("ignores everything else", () => {
    expect(isPrismaNextPackage("prisma")).toBe(false);
    expect(isPrismaNextPackage("@prisma/client")).toBe(false);
    expect(isPrismaNextPackage("dotenv")).toBe(false);
  });
});

describe("getPrismaNextPackageSpecifier", () => {
  test("emits name@version for npm specs (default and explicit)", () => {
    expect(getPrismaNextPackageSpecifier("prisma-next")).toBe("prisma-next@latest");
    expect(getPrismaNextPackageSpecifier("@prisma-next/cli", { kind: "npm", spec: "0.10.0" })).toBe(
      "@prisma-next/cli@0.10.0",
    );
    expect(getPrismaNextPackageSpecifier("@prisma-next/cli", { kind: "npm", spec: "dev" })).toBe(
      "@prisma-next/cli@dev",
    );
  });

  test("emits a pkg.pr.new URL specifier for pkg-pr-new specs", () => {
    expect(
      getPrismaNextPackageSpecifier("prisma-next", { kind: "pkg-pr-new", ref: "bad6795" }),
    ).toBe("https://pkg.pr.new/prisma/prisma-next/prisma-next@bad6795");
    expect(
      getPrismaNextPackageSpecifier("@prisma-next/cli", { kind: "pkg-pr-new", ref: "581" }),
    ).toBe("https://pkg.pr.new/prisma/prisma-next/@prisma-next/cli@581");
  });
});

describe("getDependencyVersion", () => {
  test("returns the npm spec verbatim for @prisma-next/* packages", () => {
    expect(getDependencyVersion("prisma-next")).toBe("latest");
    expect(getDependencyVersion("@prisma-next/cli", { kind: "npm", spec: "0.10.0" })).toBe(
      "0.10.0",
    );
  });

  test("returns the full pkg.pr.new URL when the spec is pkg-pr-new", () => {
    expect(getDependencyVersion("prisma-next", { kind: "pkg-pr-new", ref: "bad6795" })).toBe(
      "https://pkg.pr.new/prisma/prisma-next/prisma-next@bad6795",
    );
    expect(
      getDependencyVersion("@prisma-next/cli", { kind: "pkg-pr-new", ref: "aman/some-branch" }),
    ).toBe("https://pkg.pr.new/prisma/prisma-next/@prisma-next/cli@aman/some-branch");
  });

  test("ignores the Prisma Next spec for unrelated packages and uses dependencyVersionMap", () => {
    expect(getDependencyVersion("dotenv", { kind: "pkg-pr-new", ref: "ignored" })).toBe("^17.4.2");
    expect(getDependencyVersion("tsx", { kind: "npm", spec: "0.10.0" })).toBe("^4.21.0");
    expect(getDependencyVersion("not-a-known-package")).toBeUndefined();
  });
});
