import { describe, expect, it } from "vitest";
import {
  argvProvidesLongFlag,
  resolveVerifyCliOptions,
  VerifyCliConfigFileSchema,
} from "../src/interfaces/cli/verifyCliConfig.js";

describe("argvProvidesLongFlag", () => {
  it("detects bare flag and equals form", () => {
    expect(
      argvProvidesLongFlag(
        ["node", "c", "verify", "--target", "http://x"],
        "target",
      ),
    ).toBe(true);
    expect(
      argvProvidesLongFlag(
        ["node", "c", "verify", "--target=http://x"],
        "target",
      ),
    ).toBe(true);
    expect(argvProvidesLongFlag(["node", "c", "verify"], "target")).toBe(false);
  });
});

describe("resolveVerifyCliOptions", () => {
  it("merges file then project defaults and applies explicit CLI overrides", () => {
    const merged = resolveVerifyCliOptions({
      argv: ["node", "c", "verify", "--tools", "http"],
      file: VerifyCliConfigFileSchema.parse({
        target: "http://from-file",
        tools: "fs,http",
        out: ".from_file",
      }),
      projectDefaults: { targetUrl: "http://from-project" },
      rawCommander: {
        tools: "http",
        target: "http://from-file",
        out: ".from_file",
      },
    });
    expect(merged.target).toBe("http://from-file");
    expect(merged.tools).toBe("http");
    expect(merged.out).toBe(".from_file");
  });

  it("uses CLI target when flag is present even if file differs", () => {
    const merged = resolveVerifyCliOptions({
      argv: ["node", "c", "verify", "--target", "http://cli"],
      file: VerifyCliConfigFileSchema.parse({ target: "http://file" }),
      projectDefaults: undefined,
      rawCommander: { target: "http://cli" },
    });
    expect(merged.target).toBe("http://cli");
  });

  it("throws when target is missing everywhere", () => {
    expect(() =>
      resolveVerifyCliOptions({
        argv: ["node", "c", "verify"],
        file: null,
        projectDefaults: undefined,
        rawCommander: {},
      }),
    ).toThrow(/Missing target URL/);
  });
});
