import { describe, expect, test } from "bun:test";

import { CreateCommandInputSchema } from "./types";

describe("create command options", () => {
  test("does not expose a database URL option", () => {
    expect(Object.hasOwn(CreateCommandInputSchema.shape, "databaseUrl")).toBeFalse();
  });
});
