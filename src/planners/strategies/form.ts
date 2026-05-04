import { randomUUID } from "node:crypto";
import { Capability } from "../../capabilities/types.js";
import type { RequirementIR } from "../../spec/ir.js";
import type { Probe } from "../types.js";

export function planFormProbe(req: RequirementIR): Probe {
  return {
    id: randomUUID(),
    requirementId: req.id,
    capabilityNeeds: [Capability.interact, Capability.read_ui_structure],
    sideEffects: "ui_only",
    costHint: 3,
    strategy: "form",
    steps: [
      {
        capability: Capability.interact,
        action: "run_steps",
        args: { actions: req.actions ?? [] },
      },
      {
        capability: Capability.read_ui_structure,
        action: "snapshot_a11y_tree",
        args: {},
      },
    ],
  };
}
