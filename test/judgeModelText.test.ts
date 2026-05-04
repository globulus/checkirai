import { describe, expect, it } from "vitest";
import {
  coalesceJudgmentWhyFromRecord,
  parseLooseJudgeJsonResponse,
  stripEmbeddedReasoningFromModelText,
} from "../src/llm/judgeModelText.js";

describe("stripEmbeddedReasoningFromModelText", () => {
  it("removes think wrapper before JSON", () => {
    const inner = '{"verdict":"pass","confidence":0.9,"why":"ok"}';
    const wrapped =
      "<" + "think" + ">" + "step 1..." + "<" + "/" + "think" + ">" + inner;
    expect(stripEmbeddedReasoningFromModelText(wrapped)).toBe(inner);
  });
});

describe("parseLooseJudgeJsonResponse", () => {
  it("parses JSON after stripped thinking", () => {
    const json = '{"verdict":"fail","confidence":0.8,"why":"missing"}';
    const text = "<" + "think" + ">" + "hmm" + "<" + "/" + "think" + ">" + json;
    const out = parseLooseJudgeJsonResponse(text) as Record<string, unknown>;
    expect(out.verdict).toBe("fail");
    expect(out.why).toBe("missing");
  });

  it("extracts object from prose tail", () => {
    const out = parseLooseJudgeJsonResponse(
      'Here you go: {"verdict":"inconclusive","confidence":0.2,"why":"weak"}',
    ) as Record<string, unknown>;
    expect(out.verdict).toBe("inconclusive");
  });
});

describe("coalesceJudgmentWhyFromRecord", () => {
  it("merges why and reasoning", () => {
    const s = coalesceJudgmentWhyFromRecord({
      why: "Short.",
      reasoning: "Longer steps.",
    });
    expect(s).toContain("Short.");
    expect(s).toContain("Longer steps.");
  });

  it("uses reasoning when why missing", () => {
    expect(coalesceJudgmentWhyFromRecord({ reasoning: "Only this." })).toBe(
      "Only this.",
    );
  });
});
