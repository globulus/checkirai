import type { ObservableExpectationIR, RequirementIR, SpecIR } from "./ir.js";

export type ObservableDetailMode = "generic" | "detailed" | "both";

function deDupe(exps: ObservableExpectationIR[]): ObservableExpectationIR[] {
  const seen = new Set<string>();
  const out: ObservableExpectationIR[] = [];
  for (const e of exps) {
    const key = JSON.stringify(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function getExpectedObservables(
  spec: Pick<SpecIR, "acceptance_policy">,
  req: Pick<RequirementIR, "expected_observables" | "expected_observables_sets">,
): ObservableExpectationIR[] {
  const mode: ObservableDetailMode =
    spec.acceptance_policy?.observable_detail ?? "detailed";

  const sets = req.expected_observables_sets;
  if (!sets) return req.expected_observables ?? [];

  const generic = sets.generic ?? [];
  const detailed = sets.detailed ?? [];

  if (mode === "generic") return generic.length ? generic : req.expected_observables ?? [];
  if (mode === "detailed") return detailed.length ? detailed : req.expected_observables ?? [];
  return deDupe([
    ...(generic.length ? generic : []),
    ...(detailed.length ? detailed : []),
    ...((req.expected_observables ?? []).length ? (req.expected_observables ?? []) : []),
  ]);
}

