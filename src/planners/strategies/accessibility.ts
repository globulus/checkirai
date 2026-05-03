import type { RequirementIR } from "../../spec/ir.js";
import { planStructuralUiProbe } from "./structuralUi.js";

export function planAccessibilityProbe(req: RequirementIR) {
  const p = planStructuralUiProbe(req);
  return {
    ...p,
    strategy: "accessibility_snapshot",
    costHint: Math.max(p.costHint, 2),
  };
}
