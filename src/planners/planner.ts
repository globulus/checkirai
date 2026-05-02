import type { CapabilitySet } from "../capabilities/types.js";
import type { SpecIR } from "../spec/ir.js";
import { planBasicAppearanceProbe } from "./strategies/basicAppearance.js";
import { planFormProbe } from "./strategies/form.js";
import { planNavigationProbe } from "./strategies/navigation.js";
import { planProceduralProbe } from "./strategies/procedural.js";
import { planStructuralUiProbe } from "./strategies/structuralUi.js";
import type { Probe, ProbePlan } from "./types.js";

function canSatisfy(capabilities: CapabilitySet, probe: Probe): boolean {
  return probe.capabilityNeeds.every((c) => capabilities.has(c));
}

export function planProbes(
  spec: SpecIR,
  capabilities: CapabilitySet,
): ProbePlan {
  const probes: Probe[] = [];

  for (const req of spec.requirements) {
    let probe: Probe;
    // If the spec provides explicit steps, prefer procedural execution.
    if (
      (req.preconditions?.length ?? 0) > 0 ||
      (req.actions?.length ?? 0) > 0
    ) {
      probe = planProceduralProbe(req);
    } else {
      switch (req.type) {
        case "navigation":
          probe = planNavigationProbe(req, spec);
          break;
        case "form":
          probe = planFormProbe(req);
          break;
        case "appearance":
          probe = planBasicAppearanceProbe(req);
          break;
        default:
          probe = planStructuralUiProbe(req);
          break;
      }
    }

    // If the cheapest probe isn't satisfiable, keep it anyway; the executor/judger will mark blocked.
    // Later we can implement alternate strategies per requirement.
    if (!canSatisfy(capabilities, probe)) {
      probe.costHint += 100;
    }
    probes.push(probe);
  }

  // MVP grouping: single session.
  return {
    sessions: [
      {
        id: "default",
        probes: probes.sort((a, b) => a.costHint - b.costHint),
      },
    ],
  };
}
