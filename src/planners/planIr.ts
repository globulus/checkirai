import { z } from "zod";
import { type CapabilityName, CapabilityNameSchema } from "./types.js";

/**
 * Generic LLM-produced plan IR.
 *
 * - Tool surface is validated against MCP `listTools()` + `inputSchema`.
 * - Execution consumes ToolCalls and writes tool_output artifacts.
 * - Judging consumes collected evidence + optional rubric/bindings.
 */

export const ToolCallIRSchema = z.object({
  /** High-level capability classification for policy gating. */
  capability: CapabilityNameSchema,
  /**
   * Concrete tool name to invoke. For chrome-devtools-mcp this is e.g.
   * `navigate_page`, `wait_for`, `take_snapshot`, `evaluate_script`, etc.
   */
  tool: z.string().min(1),
  /** Tool arguments, validated against MCP inputSchema when available. */
  args: z.record(z.string(), z.unknown()).default({}),
  /** Optional per-step timeout, enforced by executor when supported. */
  timeoutMs: z.number().int().positive().optional(),
  /** Optional label for artifact metadata/debugging. */
  label: z.string().optional(),
});
export type ToolCallIR = z.infer<typeof ToolCallIRSchema>;

export const EvidenceBindingSchema = z.object({
  requirementId: z.string().min(1),
  /** Free-form identifiers of which artifacts/tool outputs matter. */
  refs: z.array(z.string()).default([]),
});
export type EvidenceBinding = z.infer<typeof EvidenceBindingSchema>;

export const RequirementRubricSchema = z.object({
  requirementId: z.string().min(1),
  /**
   * Machine-readable-ish rubric text: what would constitute pass/fail/inconclusive,
   * including how to interpret evidence outputs.
   */
  rubric: z.string().min(1),
});
export type RequirementRubric = z.infer<typeof RequirementRubricSchema>;

export const TestPlanIRSchema = z.object({
  toolCalls: z.array(ToolCallIRSchema).default([]),
  evidenceBindings: z.array(EvidenceBindingSchema).default([]),
  rubric: z.array(RequirementRubricSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type TestPlanIR = z.infer<typeof TestPlanIRSchema>;

export type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type PlanValidationIssue =
  | {
      kind: "unknown_tool";
      tool: string;
      message: string;
    }
  | {
      kind: "invalid_args";
      tool: string;
      message: string;
      details?: unknown;
    }
  | {
      kind: "invalid_capability";
      tool: string;
      message: string;
      details?: unknown;
    };

export type PlanValidationResult = {
  ok: boolean;
  issues: PlanValidationIssue[];
  score: number;
};

function schemaObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Detects common planner mistakes: `querySelector(...).innerText` throws when the
 * node is missing. Prefer `?.`, explicit null checks, or `document.body.innerText`.
 */
export function hasUnsafeDomNullDerefInEvaluateScript(
  functionSource: string,
): boolean {
  const re =
    /(?:querySelector(?:All)?|getElementById)\s*\([^)]*\)\s*\.(?:innerText|textContent|innerHTML)\b/;
  return re.test(functionSource);
}

/**
 * Minimal JSON-schema-ish validator that covers the MCP schemas we see in practice:
 * - type: object
 * - properties + required
 * - additionalProperties: false
 * - primitive types + arrays with primitive items
 */
export function validateArgsAgainstInputSchema(
  args: Record<string, unknown>,
  inputSchema: unknown,
): { ok: boolean; message?: string; details?: unknown } {
  if (!schemaObject(inputSchema)) return { ok: true };
  if (inputSchema.type !== "object") return { ok: true };

  const props = schemaObject(inputSchema.properties)
    ? inputSchema.properties
    : {};
  const required = Array.isArray(inputSchema.required)
    ? (inputSchema.required as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];

  for (const k of required) {
    if (!(k in args))
      return { ok: false, message: `Missing required arg: ${k}` };
  }

  if (inputSchema.additionalProperties === false) {
    for (const k of Object.keys(args)) {
      if (!(k in props)) return { ok: false, message: `Unexpected arg: ${k}` };
    }
  }

  for (const [k, val] of Object.entries(args)) {
    const propSchema = (props as Record<string, unknown>)[k];
    if (!schemaObject(propSchema)) continue;
    const t = propSchema.type;
    if (t === "string" && typeof val !== "string")
      return { ok: false, message: `Invalid type for ${k}: expected string` };
    if (t === "integer" && !(typeof val === "number" && Number.isInteger(val)))
      return { ok: false, message: `Invalid type for ${k}: expected integer` };
    if (t === "number" && typeof val !== "number")
      return { ok: false, message: `Invalid type for ${k}: expected number` };
    if (t === "boolean" && typeof val !== "boolean")
      return { ok: false, message: `Invalid type for ${k}: expected boolean` };
    if (t === "array") {
      if (!Array.isArray(val))
        return { ok: false, message: `Invalid type for ${k}: expected array` };
      const items = propSchema.items;
      if (schemaObject(items) && typeof items.type === "string") {
        const it = items.type;
        for (const item of val) {
          if (it === "string" && typeof item !== "string")
            return {
              ok: false,
              message: `Invalid array item for ${k}: expected string`,
            };
          if (
            it === "integer" &&
            !(typeof item === "number" && Number.isInteger(item))
          )
            return {
              ok: false,
              message: `Invalid array item for ${k}: expected integer`,
            };
        }
      }
    }
  }

  return { ok: true };
}

export function validatePlan(
  plan: TestPlanIR,
  tools: ToolDescriptor[],
): PlanValidationResult {
  const toolSet = new Map(tools.map((t) => [t.name, t] as const));
  const issues: PlanValidationIssue[] = [];

  for (const c of plan.toolCalls) {
    const td = toolSet.get(c.tool);
    if (!td) {
      issues.push({
        kind: "unknown_tool",
        tool: c.tool,
        message: `Unknown tool: ${c.tool}`,
      });
      continue;
    }
    const res = validateArgsAgainstInputSchema(c.args ?? {}, td.inputSchema);
    if (!res.ok) {
      issues.push({
        kind: "invalid_args",
        tool: c.tool,
        message: res.message ?? "Invalid args",
        details: res.details,
      });
    }

    if (c.tool === "evaluate_script") {
      const fn = (c.args as Record<string, unknown> | undefined)?.function;
      if (typeof fn === "string" && hasUnsafeDomNullDerefInEvaluateScript(fn)) {
        issues.push({
          kind: "invalid_args",
          tool: c.tool,
          message:
            "evaluate_script must not dereference querySelector/getElementById without optional chaining or a null check before .innerText/.textContent/.innerHTML",
        });
      }
    }
  }

  // Score: start at 100, subtract penalties.
  let score = 100;
  for (const i of issues) {
    score -= i.kind === "unknown_tool" ? 50 : 10;
  }
  if (score < 0) score = 0;
  return { ok: issues.length === 0, issues, score };
}

export function requiredPolicyForCapabilities(
  caps: Set<CapabilityName>,
): "read_only" | "ui_only" {
  return caps.has("interact") ? "ui_only" : "read_only";
}
