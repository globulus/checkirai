import { randomUUID } from "node:crypto";
import type { RequirementIR } from "../../spec/ir.js";
import type { SpecIR } from "../../spec/ir.js";
import { getExpectedObservables } from "../../spec/observables.js";
import type { Probe } from "../types.js";

export function planNavigationProbe(req: RequirementIR, spec?: SpecIR): Probe {
  const exps = spec
    ? getExpectedObservables(spec, req)
    : req.expected_observables;
  return {
    id: randomUUID(),
    requirementId: req.id,
    capabilityNeeds: ["navigate", "read_ui_structure"],
    sideEffects: "none",
    costHint: 2,
    strategy: "navigation",
    steps: [
      {
        capability: "navigate",
        action: "navigate_page",
        args: {
          url: exps.find((o) => o.kind === "url_matches")?.url,
        },
      },
      {
        capability: "read_ui_structure",
        action: "take_snapshot",
        args: {},
      },
    ],
  };
}
