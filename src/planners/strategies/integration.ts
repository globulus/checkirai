import { randomUUID } from "node:crypto";
import type { RequirementIR, SpecIR } from "../../spec/ir.js";
import { getExpectedObservables } from "../../spec/observables.js";
import type { Probe } from "../types.js";

export function planIntegrationProbe(req: RequirementIR, spec: SpecIR): Probe {
  const exps = getExpectedObservables(spec, req);
  const url =
    exps.find((e) => e.kind === "http_response" && e.url)?.url ??
    exps.find((e) => e.kind === "network_request" && e.url)?.url ??
    spec.environment_hints?.baseUrl?.trim() ??
    "";

  const steps: Probe["steps"] = [];
  if (url) {
    steps.push({
      capability: "call_http",
      action: "get",
      args: { url },
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
    capabilityNeeds: url
      ? (["call_http", "read_ui_structure"] as const)
      : (["read_ui_structure"] as const),
    sideEffects: "none",
    costHint: url ? 5 : 1,
    strategy: "integration_http",
    steps,
  };
}
