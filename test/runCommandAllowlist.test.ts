import { describe, expect, it } from "vitest";
import { isRunCommandAllowlisted } from "../src/shared/runCommandAllowlist.js";

describe("isRunCommandAllowlisted", () => {
  it("denies when allowlist is empty or missing", () => {
    expect(isRunCommandAllowlisted(undefined, "echo", [])).toBe(false);
    expect(isRunCommandAllowlisted([], "echo", [])).toBe(false);
  });

  it("matches exact command line", () => {
    expect(isRunCommandAllowlisted(["pnpm test"], "pnpm", ["test"])).toBe(true);
    expect(isRunCommandAllowlisted(["pnpm test"], "pnpm", ["lint"])).toBe(
      false,
    );
  });

  it("matches prefix when entry ends with *", () => {
    expect(isRunCommandAllowlisted(["pnpm*"], "pnpm", ["test", "--run"])).toBe(
      true,
    );
    expect(isRunCommandAllowlisted(["npm*"], "pnpm", ["test"])).toBe(false);
  });
});
