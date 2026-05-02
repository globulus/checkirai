import { randomUUID } from "node:crypto";
import type { RequirementIR } from "../../spec/ir.js";
import type { Probe } from "../types.js";

export function planStructuralUiProbe(req: RequirementIR): Probe {
  return {
    id: randomUUID(),
    requirementId: req.id,
    capabilityNeeds: ["read_ui_structure"],
    sideEffects: "none",
    costHint: 1,
    strategy: "structural_ui",
    steps: [
      {
        capability: "read_ui_structure",
        action: "take_snapshot",
        args: {},
      },
    ],
  };
}
