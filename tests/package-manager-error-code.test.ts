import { describe, expect, test } from "bun:test";

import { getPackageManagerErrorCode } from "../src/utils/package-manager-error-code";
import { packageManagerOutputFixtures } from "./fixtures/package-manager-output";

// Deliberately restated here so a loosened grammar in the module fails this suite.
const SAFE_IDENTIFIER = /^(?:E[A-Z0-9_]{2,40}|ERR_PNPM_[A-Z0-9_]{1,60}|YN\d{4})$/;

const secrets = [
  "/Users/jane/projects/my-app",
  "C:\\Users\\jane\\my-app",
  "https://jane:hunter2@registry.example.com/",
  "jane@example.com",
  "npm_AbCdEf0123456789",
  "@acme/internal-package",
  "DATABASE_URL=postgresql://jane:hunter2@db.example.com/app",
];

describe("getPackageManagerErrorCode", () => {
  for (const fixture of packageManagerOutputFixtures) {
    test(fixture.name, () => {
      expect(getPackageManagerErrorCode(fixture.command, fixture)).toBe(fixture.expected);
    });
  }

  test("resolves the manager from a Windows shim path", () => {
    expect(
      getPackageManagerErrorCode("C:\\Program Files\\nodejs\\npm.cmd", {
        stdout: "",
        stderr: "npm error code E404\r\nnpm error 404 Not Found\r\n",
      }),
    ).toBe("E404");
  });

  test("ignores identifiers printed by a command that is not a known package manager", () => {
    for (const command of ["node", "bun", "deno", "prisma", "npmx", "__proto__", "constructor"]) {
      expect(
        getPackageManagerErrorCode(command, {
          stdout: "[ERR_PNPM_FETCH_404] nope\n➤ YN0035: │ nope",
          stderr: "npm error code E404",
        }),
      ).toBeUndefined();
    }
  });

  test("reads another manager's format as prose", () => {
    expect(
      getPackageManagerErrorCode("npm", { stdout: "[ERR_PNPM_FETCH_404] nope", stderr: "" }),
    ).toBeUndefined();
    expect(
      getPackageManagerErrorCode("yarn", { stdout: "", stderr: "npm error code E404" }),
    ).toBeUndefined();
  });

  test("ignores an identifier relayed from a nested package manager", () => {
    expect(
      getPackageManagerErrorCode("npm", {
        stdout: "",
        stderr: "npm error code 1\nnpm error npm error code E404\nnpm error   code: 'E404',",
      }),
    ).toBeUndefined();
  });

  test("never returns free text from the identifier position", () => {
    const cases = secrets.flatMap((secret) => [
      { command: "npm", stdout: "", stderr: `npm error code ${secret}` },
      { command: "npm", stdout: "", stderr: `npm error code E404 ${secret}` },
      { command: "npm", stdout: "", stderr: `npm ERR! code E${secret}` },
      { command: "pnpm", stdout: `[${secret}] failed`, stderr: "" },
      { command: "pnpm", stdout: `[ERR_PNPM_${secret}] failed`, stderr: "" },
      { command: "pnpm", stdout: `\u2009${secret}\u2009 failed`, stderr: "" },
      { command: "yarn", stdout: `➤ ${secret}: │ failed`, stderr: "" },
      { command: "yarn", stdout: `➤ YN0001${secret}: │ failed`, stderr: "" },
    ]);
    for (const output of cases) {
      expect(getPackageManagerErrorCode(output.command, output)).toBeUndefined();
    }
  });

  test("rejects identifiers outside each grammar", () => {
    const cases = [
      { command: "npm", stdout: "", stderr: "npm error code e404" },
      { command: "npm", stdout: "", stderr: "npm error code 1" },
      { command: "npm", stdout: "", stderr: `npm error code E${"A".repeat(41)}` },
      { command: "npm", stdout: "", stderr: "  npm error code E404" },
      { command: "pnpm", stdout: "[WARN] deprecated left-pad@1.3.0", stderr: "" },
      { command: "pnpm", stdout: `[ERR_PNPM_${"A".repeat(61)}] failed`, stderr: "" },
      { command: "pnpm", stdout: "see [ERR_PNPM_FETCH_404] in the docs", stderr: "" },
      { command: "yarn", stdout: "➤ YN0000: · Failed with errors in 0s 403ms", stderr: "" },
      { command: "yarn", stdout: "➤ YN00821: │ failed", stderr: "" },
    ];
    for (const output of cases) {
      expect(getPackageManagerErrorCode(output.command, output)).toBeUndefined();
    }
  });

  test("returns nothing or a grammar-conforming identifier when output is full of secrets", () => {
    for (const fixture of packageManagerOutputFixtures) {
      const noise = secrets.join("\n");
      const code = getPackageManagerErrorCode(fixture.command, {
        stdout: `${noise}\n${fixture.stdout}\n${noise}`,
        stderr: `${noise}\n${fixture.stderr}\n${noise}`,
      });
      expect(code).toBe(fixture.expected);
      if (code !== undefined) expect(code).toMatch(SAFE_IDENTIFIER);
    }
  });

  test("returns nothing when verbose installs inherit stdio and capture no output", () => {
    for (const command of ["npm", "pnpm", "yarn", "bun", "deno"]) {
      expect(getPackageManagerErrorCode(command, { stdout: "", stderr: "" })).toBeUndefined();
    }
  });
});
