import type { RequirementIR } from "../../spec/ir.js";
import { planStructuralUiProbe } from "./structuralUi.js";

export function planVisibleStateProbe(req: RequirementIR) {
  const p = planStructuralUiProbe(req);
  return {
    ...p,
    strategy: "visible_state",
    costHint: Math.max(p.costHint, 1),
  };
}
