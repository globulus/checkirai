import { describe, expect, it } from "vitest";
import dashboardFixture from "../fixtures/dashboard-spec.ir.json";
import {
  mergeButtonStyleEvidenceIfNeeded,
  planHasButtonStyleEvaluateScript,
  specNeedsButtonComputedStyleEvidence,
} from "../src/planners/buttonStyleEvidence.js";
import type { SpecIR } from "../src/spec/ir.js";
import type { TestPlanIR } from "../src/planners/planIr.js";

describe("specNeedsButtonComputedStyleEvidence", () => {
  it("is true for dashboard fixture (appearance + css observable)", () => {
    expect(
      specNeedsButtonComputedStyleEvidence(dashboardFixture as SpecIR),
    ).toBe(true);
  });
});

describe("mergeButtonStyleEvidenceIfNeeded", () => {
  it("appends evaluate_script when missing", () => {
    const plan: TestPlanIR = {
      toolCalls: [
        {
          capability: "read_ui_structure",
          tool: "take_snapshot",
          args: {},
        },
      ],
      evidenceBindings: [],
      rubric: [],
      assumptions: [],
    };
    const merged = mergeButtonStyleEvidenceIfNeeded(
      dashboardFixture as SpecIR,
      plan,
    );
    expect(merged.toolCalls.length).toBe(2);
    expect(planHasButtonStyleEvaluateScript(merged)).toBe(true);
  });

  it("does not duplicate when plan already has style script", () => {
    const plan: TestPlanIR = {
      toolCalls: [
        {
          capability: "read_visual",
          tool: "evaluate_script",
          args: {
            function:
              "() => { const cs = getComputedStyle(document.body); return { color: cs.color, backgroundColor: cs.backgroundColor }; }",
          },
        },
      ],
      evidenceBindings: [],
      rubric: [],
      assumptions: [],
    };
    const merged = mergeButtonStyleEvidenceIfNeeded(
      dashboardFixture as SpecIR,
      plan,
    );
    expect(merged.toolCalls.length).toBe(1);
  });
});
