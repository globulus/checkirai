import { randomUUID } from "node:crypto";
import { Capability } from "../../capabilities/types.js";
import type { RequirementIR, SpecIR } from "../../spec/ir.js";
import type { Probe } from "../types.js";

/** Navigate → snapshot → reload (same URL) → snapshot to observe post-reload state. */
export function planPersistenceProbe(req: RequirementIR, spec: SpecIR): Probe {
  const base = spec.environment_hints?.baseUrl?.trim() ?? "";
  const steps: Probe["steps"] = [];
  if (base) {
    steps.push({
      capability: Capability.navigate,
      action: "navigate_page",
      args: { url: base },
    });
  }
  steps.push({
    capability: Capability.read_ui_structure,
    action: "take_snapshot",
    args: {},
  });
  if (base) {
    steps.push({
      capability: Capability.navigate,
      action: "navigate_page",
      args: { url: base },
    });
  }
  steps.push({
    capability: Capability.read_ui_structure,
    action: "take_snapshot",
    args: {},
  });
  return {
    id: randomUUID(),
    requirementId: req.id,
    capabilityNeeds: base
      ? ([Capability.navigate, Capability.read_ui_structure] as const)
      : ([Capability.read_ui_structure] as const),
    sideEffects: "ui_only",
    costHint: 8,
    strategy: "persistence_reload",
    steps,
  };
}
