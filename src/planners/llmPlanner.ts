import { performance } from "node:perf_hooks";
import type { z } from "zod";
import {
  chatJsonForRole,
  policyForPlannerLlmCall,
} from "../llm/chatForRole.js";
import type { LlmPolicy } from "../llm/types.js";
import type { McpToolDescriptor } from "../mcp/client.js";
import { VerifierError } from "../shared/errors.js";
import type { SpecIR } from "../spec/ir.js";
import {
  type PlanValidationResult,
  type TestPlanIR,
  TestPlanIRSchema,
  type ToolDescriptor,
  validatePlan,
} from "./planIr.js";

const PlannerOutputSchema = TestPlanIRSchema;
type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

function toolSummary(tools: McpToolDescriptor[]) {
  return tools
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    }))
    .slice(0, 200);
}

function toToolDescriptors(tools: McpToolDescriptor[]): ToolDescriptor[] {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
  }));
}

function pickBestAttempt(
  attempts: Array<{ plan: TestPlanIR; validation: PlanValidationResult }>,
) {
  // Prefer valid; then higher score; then fewer issues; then fewer tool calls.
  const sorted = attempts.slice().sort((a, b) => {
    if (a.validation.ok !== b.validation.ok) return a.validation.ok ? -1 : 1;
    if (a.validation.score !== b.validation.score)
      return b.validation.score - a.validation.score;
    if (a.validation.issues.length !== b.validation.issues.length)
      return a.validation.issues.length - b.validation.issues.length;
    return a.plan.toolCalls.length - b.plan.toolCalls.length;
  });
  return sorted[0];
}

async function generatePlanOnce(opts: {
  llm: LlmPolicy;
  spec: SpecIR;
  targetUrl: string;
  tools: McpToolDescriptor[];
  attempt: number;
  dartProjectRoot?: string;
  plannerHints?: string[];
  onSelectedModel?: (model: string) => void;
}): Promise<{ plan: PlannerOutput; raw: string }> {
  const system = "You are a generic test planner. Produce ONLY JSON. No prose.";

  const prompt = [
    "You must output JSON matching this type:",
    "",
    "TestPlanIR = {",
    "  toolCalls: Array<{ capability: CapabilityName, tool: string, args: object, timeoutMs?: number, label?: string }>,",
    "  evidenceBindings: Array<{ requirementId: string, refs: string[] }>,",
    "  rubric: Array<{ requirementId: string, rubric: string }>,",
    "  assumptions: string[],",
    "  notes?: string",
    "}",
    "",
    'CapabilityName = "navigate"|"read_ui_structure"|"read_visual"|"interact"|"read_console"|"read_network"|"read_files"|"run_command"|"call_http"|"run_automated_tests"|"read_flutter_runtime"',
    "",
    "Rules:",
    "- Only use tools that exist in the provided MCP tool list.",
    "- Tool args MUST conform to the provided tool inputSchema (required keys, types, additionalProperties=false).",
    "- Every requirement must have enough evidence: include at least one of take_snapshot / take_screenshot / evaluate_script / run_tests / get_widget_tree / flutter_driver / list_* as appropriate.",
    "- For text_present / visible copy: prefer take_snapshot (and optional take_screenshot) over many evaluate_script calls.",
    "- For Flutter/Dart tools: pass project roots as file: URIs in roots[].root; call get_widget_tree before inventing flutter_driver finders; prefer run_tests when requirements are covered by automated tests.",
    "- For requirement type `appearance` or any expected_observable with CSS (e.g. element_visible + metadata.css colors): you MUST include evaluate_script that returns getComputedStyle(...) fields (color, backgroundColor, borderColor) for the relevant elements (a11y snapshots do not include colors).",
    "- evaluate_script MUST NOT throw: never use document.querySelector(...).innerText without optional chaining (?.) or an explicit null guard; invented class names or tag names not in SPEC_IR will fail at runtime.",
    "- Keep timeouts bounded (e.g. wait_for timeout <= 10000ms unless justified).",
    "- Prefer a single navigation to targetUrl early, then evidence collection.",
    "- Avoid redundant calls unless needed for evidence.",
    "",
    `TARGET_URL: ${opts.targetUrl}`,
    ...(opts.dartProjectRoot
      ? [`DART_PROJECT_ROOT: ${opts.dartProjectRoot}`, ""]
      : []),
    ...(opts.plannerHints?.length
      ? ["", ...opts.plannerHints.map((hint) => `- ${hint}`), ""]
      : []),
    "",
    "AVAILABLE_MCP_TOOLS:",
    JSON.stringify(toolSummary(opts.tools), null, 2),
    "",
    "SPEC_IR:",
    JSON.stringify(opts.spec, null, 2),
    "",
    `ATTEMPT: ${opts.attempt}`,
    "",
    "Output JSON only.",
  ].join("\n");

  const planPolicy = policyForPlannerLlmCall(opts.llm);
  if (planPolicy.plannerAssist.provider === "none") {
    throw new VerifierError(
      "CONFIG_ERROR",
      "LLM plannerAssist and judge are both disabled (provider none); cannot plan.",
    );
  }

  const { responseText, modelUsed } = await chatJsonForRole(
    planPolicy,
    "plannerAssist",
    { system, prompt },
    opts.onSelectedModel ? { onSelectedModel: opts.onSelectedModel } : {},
  );
  const json = JSON.parse(responseText) as unknown;
  return { plan: PlannerOutputSchema.parse(json), raw: responseText };
}

export async function planWithSelfConsistency(opts: {
  llm: LlmPolicy;
  spec: SpecIR;
  targetUrl: string;
  tools: McpToolDescriptor[];
  attempts?: number; // default 5
  dartProjectRoot?: string;
  plannerHints?: string[];
  onSelectedModel?: (model: string) => void;
}): Promise<{
  plan: TestPlanIR;
  meta: {
    durationMs: number;
    attempted: number;
    valid: number;
    chosenScore: number;
    issuesSample?: unknown;
  };
}> {
  const startedAt = performance.now();
  const attempts = typeof opts.attempts === "number" ? opts.attempts : 5;
  const toolDescriptors = toToolDescriptors(opts.tools);

  const collected: Array<{
    plan: TestPlanIR;
    validation: PlanValidationResult;
  }> = [];

  for (let i = 1; i <= attempts; i++) {
    try {
      const { plan } = await generatePlanOnce({
        llm: opts.llm,
        spec: opts.spec,
        targetUrl: opts.targetUrl,
        tools: opts.tools,
        attempt: i,
        ...(opts.dartProjectRoot
          ? { dartProjectRoot: opts.dartProjectRoot }
          : {}),
        ...(opts.plannerHints?.length
          ? { plannerHints: opts.plannerHints }
          : {}),
        ...(opts.onSelectedModel
          ? { onSelectedModel: opts.onSelectedModel }
          : {}),
      });
      const validation = validatePlan(plan, toolDescriptors);
      collected.push({ plan, validation });
    } catch (e) {
      // Treat as invalid attempt.
      collected.push({
        plan: {
          toolCalls: [],
          evidenceBindings: [],
          rubric: [],
          assumptions: [],
        },
        validation: {
          ok: false,
          score: 0,
          issues: [
            {
              kind: "invalid_args",
              tool: "__planner__",
              message: e instanceof Error ? e.message : String(e),
            },
          ],
        },
      });
    }
  }

  const best = pickBestAttempt(collected);
  if (!best) {
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      "Planner produced no attempts.",
    );
  }
  const valid = collected.filter((a) => a.validation.ok).length;
  return {
    plan: best.plan,
    meta: {
      durationMs: Math.round(performance.now() - startedAt),
      attempted: attempts,
      valid,
      chosenScore: best.validation.score,
      issuesSample: best.validation.ok
        ? undefined
        : best.validation.issues.slice(0, 5),
    },
  };
}
