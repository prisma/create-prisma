import { describe, expect, test } from "bun:test";

import { getPackageManagerErrorCode } from "../src/utils/package-manager-error-code";

describe("getPackageManagerErrorCode", () => {
  test.each([
    [
      "npm",
      "npm error code ETARGET\nnpm error notarget No matching version found for left-pad@99.99.99.",
      "ETARGET",
    ],
    [
      "npm",
      "npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for left-pad@99.99.99.",
      "ETARGET",
    ],
    [
      "npm",
      "npm error code 3\nnpm error path /Users/jane/my-app\nnpm error command failed",
      undefined,
    ],
    [
      "pnpm",
      "[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/nope: Not Found - 404",
      "ERR_PNPM_FETCH_404",
    ],
    [
      "pnpm",
      "\u2009ERR_PNPM_NO_MATCHING_VERSION\u2009 No matching version found for left-pad@99.99.99",
      "ERR_PNPM_NO_MATCHING_VERSION",
    ],
    [
      "yarn",
      "➤ YN0000: ┌ Resolution step\n➤ YN0082: │ left-pad@npm:99.99.99: No candidates found\n➤ YN0000: · Failed with errors in 0s 403ms",
      "YN0082",
    ],
    [
      "bun",
      'error: No version matching "99.99.99" found for specifier "left-pad" (but package exists)',
      undefined,
    ],
  ])("%s: %s", (command, output, expected) => {
    expect(getPackageManagerErrorCode(command, { stdout: output, stderr: "" })).toBe(expected);
    expect(getPackageManagerErrorCode(command, { stdout: "", stderr: output })).toBe(expected);
  });

  test("never returns free text from the identifier position", () => {
    for (const secret of [
      "/Users/jane/my-app",
      "https://jane:hunter2@registry.example.com/",
      "npm_AbCdEf0123456789",
    ]) {
      for (const [command, output] of [
        ["npm", `npm error code ${secret}`],
        ["pnpm", `[${secret}] failed`],
        ["yarn", `➤ ${secret}: │ failed`],
      ] as const) {
        expect(
          getPackageManagerErrorCode(command, { stdout: output, stderr: output }),
        ).toBeUndefined();
      }
    }
  });
});
