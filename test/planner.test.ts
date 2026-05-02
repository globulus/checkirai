import { describe, expect, it } from "vitest";
import type { CapabilityName } from "../src/capabilities/types.js";
import { planProbes } from "../src/planners/planner.js";
import { SpecIRSchema } from "../src/spec/ir.js";

describe("planProbes", () => {
  it("creates one session with probes per requirement", () => {
    const spec = SpecIRSchema.parse({
      run_goal: "x",
      requirements: [
        {
          id: "a",
          source_text: "A",
          type: "structure",
          priority: "must",
          expected_observables: [],
        },
        {
          id: "b",
          source_text: "B",
          type: "appearance",
          priority: "must",
          expected_observables: [],
        },
      ],
    });
    const caps = new Set<CapabilityName>(["read_ui_structure", "read_visual"]);
    const plan = planProbes(spec, caps);
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]?.probes).toHaveLength(2);
  });
});
