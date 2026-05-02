import { describe, expect, it } from "vitest";
import { normalizeMarkdownToSpecIR } from "../src/spec/normalize.js";

describe("normalizeMarkdownToSpecIR", () => {
  it("turns bullet lines into requirements", () => {
    const md = `
# Title

- Must show a button
- Must allow saving
`;
    const spec = normalizeMarkdownToSpecIR(md);
    expect(spec.requirements).toHaveLength(2);
    expect(spec.requirements[0]?.id).toBe("req-1");
    expect(spec.requirements[0]?.source_text).toContain("Must show a button");
  });
});
