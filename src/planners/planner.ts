import type { CapabilitySet } from "../capabilities/types.js";
import type { RequirementIR, SpecIR } from "../spec/ir.js";
import { planAccessibilityProbe } from "./strategies/accessibility.js";
import { planBasicAppearanceProbe } from "./strategies/basicAppearance.js";
import { planFormProbe } from "./strategies/form.js";
import { planIntegrationProbe } from "./strategies/integration.js";
import { planNavigationProbe } from "./strategies/navigation.js";
import { planPersistenceProbe } from "./strategies/persistence.js";
import { planProceduralProbe } from "./strategies/procedural.js";
import { planStructuralUiProbe } from "./strategies/structuralUi.js";
import { planVisibleStateProbe } from "./strategies/visibleState.js";
import type { Probe, ProbePlan } from "./types.js";

function canSatisfy(capabilities: CapabilitySet, probe: Probe): boolean {
  return probe.capabilityNeeds.every((c) => capabilities.has(c));
}

function topoSortRequirements(reqs: RequirementIR[]): RequirementIR[] {
  const byId = new Map(reqs.map((r) => [r.id, r] as const));
  const dependents = new Map<string, string[]>();
  for (const r of reqs) {
    for (const d of r.depends_on ?? []) {
      if (!byId.has(d)) continue;
      const arr = dependents.get(d) ?? [];
      arr.push(r.id);
      dependents.set(d, arr);
    }
  }
  const inDegree = new Map<string, number>();
  for (const r of reqs) {
    inDegree.set(r.id, (r.depends_on ?? []).filter((d) => byId.has(d)).length);
  }
  const q = reqs.filter((r) => inDegree.get(r.id) === 0).map((r) => r.id);
  const out: RequirementIR[] = [];
  while (q.length) {
    const id = q.shift();
    if (!id) break;
    const node = byId.get(id);
    if (node) out.push(node);
    for (const c of dependents.get(id) ?? []) {
      inDegree.set(c, (inDegree.get(c) ?? 0) - 1);
      if (inDegree.get(c) === 0) q.push(c);
    }
  }
  if (out.length < reqs.length) {
    const seen = new Set(out.map((r) => r.id));
    for (const r of reqs) {
      if (!seen.has(r.id)) out.push(r);
    }
  }
  return out;
}

export type PlanProbesOptions = {
  /** One session per probe: sequential execution with a fresh navigate bootstrap per session. */
  isolateSessions?: boolean;
};

export function planProbes(
  spec: SpecIR,
  capabilities: CapabilitySet,
  opts?: PlanProbesOptions,
): ProbePlan {
  const probes: Probe[] = [];
  const reqs = topoSortRequirements(spec.requirements);

  for (const req of reqs) {
    let probe: Probe;
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
        case "persistence":
          probe = planPersistenceProbe(req, spec);
          break;
        case "accessibility":
          probe = planAccessibilityProbe(req);
          break;
        case "integration":
          probe = planIntegrationProbe(req, spec);
          break;
        case "visible_state":
          probe = planVisibleStateProbe(req);
          break;
        default:
          probe = planStructuralUiProbe(req);
          break;
      }
    }

    if (!canSatisfy(capabilities, probe)) {
      probe.costHint += 100;
    }
    probes.push(probe);
  }

  const ordered = probes.sort((a, b) => a.costHint - b.costHint);

  if (opts?.isolateSessions) {
    return {
      sessions: ordered.map((p, i) => ({
        id: `iso-${i}`,
        probes: [p],
      })),
    };
  }

  return {
    sessions: [
      {
        id: "default",
        probes: ordered,
      },
    ],
  };
}
