import { describe, expect, it } from "vitest";
import { judgeDeterministic } from "../src/evaluators/judge.js";
import { ProbePlanSchema } from "../src/planners/types.js";
import { SpecIRSchema } from "../src/spec/ir.js";

describe("judgeDeterministic", () => {
  it("marks requirement blocked if any probe tool call failed", () => {
    const spec = SpecIRSchema.parse({
      run_goal: "x",
      requirements: [
        {
          id: "req-1",
          source_text: "x",
          type: "structure",
          priority: "must",
          expected_observables: [],
        },
      ],
    });
    const plan = ProbePlanSchema.parse({
      sessions: [
        {
          id: "default",
          probes: [
            {
              id: "probe-1",
              requirementId: "req-1",
              capabilityNeeds: [],
              steps: [],
              sideEffects: "none",
              costHint: 0,
            },
          ],
        },
      ],
    });
    const toolCalls = [
      {
        id: "tc-1",
        runId: "run-1",
        probeId: "probe-1",
        capability: "read_ui_structure",
        action: "snapshot",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        ok: false,
        errorCode: "TOOL_UNAVAILABLE",
        errorMessage: "nope",
      },
    ];
    const res = judgeDeterministic({
      spec,
      plan,
      toolCalls,
      artifacts: [],
      artifactRootDir: ".verifier/artifacts",
    });
    expect(res[0]?.verdict).toBe("blocked");
  });
});
