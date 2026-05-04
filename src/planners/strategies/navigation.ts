import { randomUUID } from "node:crypto";
import { Capability } from "../../capabilities/types.js";
import type { RequirementIR, SpecIR } from "../../spec/ir.js";
import { getExpectedObservables } from "../../spec/observables.js";
import type { Probe } from "../types.js";

export function planNavigationProbe(req: RequirementIR, spec?: SpecIR): Probe {
  const exps = spec
    ? getExpectedObservables(spec, req)
    : req.expected_observables;
  return {
    id: randomUUID(),
    requirementId: req.id,
    capabilityNeeds: [Capability.navigate, Capability.read_ui_structure],
    sideEffects: "none",
    costHint: 2,
    strategy: "navigation",
    steps: [
      {
        capability: Capability.navigate,
        action: "navigate_page",
        args: {
          url: exps.find((o) => o.kind === "url_matches")?.url,
        },
      },
      {
        capability: Capability.read_ui_structure,
        action: "take_snapshot",
        args: {},
      },
    ],
  };
}
