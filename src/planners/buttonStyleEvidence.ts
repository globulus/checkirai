import type { SpecIR } from "../spec/ir.js";
import { getExpectedObservables } from "../spec/observables.js";
import type { TestPlanIR, ToolCallIR } from "./planIr.js";

/**
 * Same shape as the verify empty-plan fallback: computed styles for buttons so
 * judges can verify color/background expectations (a11y snapshot has no CSS).
 */
export const DEFAULT_BUTTON_STYLE_TOOL_CALL: ToolCallIR = {
  capability: "read_visual",
  tool: "evaluate_script",
  args: {
    function: `() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  return buttons.map((b) => {
    const cs = getComputedStyle(b);
    const text = (b.innerText || b.textContent || "").trim();
    return {
      text,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
    };
  });
}`,
  },
  label: "button_styles",
};

export function specNeedsButtonComputedStyleEvidence(spec: SpecIR): boolean {
  for (const r of spec.requirements) {
    if (r.type === "appearance") return true;
    for (const e of getExpectedObservables(spec, r)) {
      if (e.kind !== "element_visible") continue;
      const meta = e.metadata;
      if (meta && typeof meta === "object" && "css" in meta) return true;
    }
  }
  return false;
}

export function planHasButtonStyleEvaluateScript(plan: TestPlanIR): boolean {
  for (const c of plan.toolCalls) {
    if (c.tool !== "evaluate_script") continue;
    const fn = (c.args as Record<string, unknown> | undefined)?.function;
    if (typeof fn !== "string") continue;
    if (
      /getComputedStyle\s*\(/.test(fn) &&
      (/backgroundColor/.test(fn) || /\bcolor\b/.test(fn))
    ) {
      return true;
    }
  }
  return false;
}

/** Append default button style probe when the spec needs CSS evidence but the plan omitted it. */
export function mergeButtonStyleEvidenceIfNeeded(
  spec: SpecIR,
  plan: TestPlanIR,
): TestPlanIR {
  if (!specNeedsButtonComputedStyleEvidence(spec)) return plan;
  if (planHasButtonStyleEvaluateScript(plan)) return plan;
  return {
    ...plan,
    toolCalls: [...plan.toolCalls, DEFAULT_BUTTON_STYLE_TOOL_CALL],
  };
}
