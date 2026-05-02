import type { CapabilitySet } from "../capabilities/types.js";
import type { ExecutorIntegrations } from "../executors/integrations.js";
import { planProbes } from "../planners/planner.js";
import type { ProbePlan } from "../planners/types.js";
import type { SpecIR } from "../spec/ir.js";

export function planForRequirements(
  spec: SpecIR,
  capabilities: CapabilitySet,
  requirementIds?: string[],
): ProbePlan {
  if (!requirementIds || requirementIds.length === 0)
    return planProbes(spec, capabilities);
  const filtered: SpecIR = {
    ...spec,
    requirements: spec.requirements.filter((r) =>
      requirementIds.includes(r.id),
    ),
  };
  return planProbes(filtered, capabilities);
}

export type RerunInput = {
  spec: SpecIR;
  capabilities: CapabilitySet;
  integrations: ExecutorIntegrations;
  requirementIds: string[];
};
