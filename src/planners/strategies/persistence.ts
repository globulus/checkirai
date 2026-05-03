import { randomUUID } from "node:crypto";
import type { RequirementIR, SpecIR } from "../../spec/ir.js";
import type { Probe } from "../types.js";

/** Navigate → snapshot → reload (same URL) → snapshot to observe post-reload state. */
export function planPersistenceProbe(req: RequirementIR, spec: SpecIR): Probe {
  const base = spec.environment_hints?.baseUrl?.trim() ?? "";
  const steps: Probe["steps"] = [];
  if (base) {
    steps.push({
      capability: "navigate",
      action: "navigate_page",
      args: { url: base },
    });
  }
  steps.push({
    capability: "read_ui_structure",
    action: "take_snapshot",
    args: {},
  });
  if (base) {
    steps.push({
      capability: "navigate",
      action: "navigate_page",
      args: { url: base },
    });
  }
  steps.push({
    capability: "read_ui_structure",
    action: "take_snapshot",
    args: {},
  });
  return {
    id: randomUUID(),
    requirementId: req.id,
    capabilityNeeds: base
      ? (["navigate", "read_ui_structure"] as const)
      : (["read_ui_structure"] as const),
    sideEffects: "ui_only",
    costHint: 8,
    strategy: "persistence_reload",
    steps,
  };
}
