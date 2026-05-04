import { randomUUID } from "node:crypto";
import { Capability } from "../../capabilities/types.js";
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
      capability: Capability.call_http,
      action: "get",
      args: { url },
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
    capabilityNeeds: url
      ? ([Capability.call_http, Capability.read_ui_structure] as const)
      : ([Capability.read_ui_structure] as const),
    sideEffects: "none",
    costHint: url ? 5 : 1,
    strategy: "integration_http",
    steps,
  };
}
