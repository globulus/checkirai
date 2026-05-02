import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { LlmPolicy } from "../llm/types.js";
import { ensureModelAvailable } from "../llm/modelOps.js";
import { ollamaGenerate } from "../llm/ollamaHttp.js";
import type { McpToolDescriptor } from "../mcp/client.js";
import { VerifierError } from "../shared/errors.js";
import { StepSchema, type SpecIR, SpecIRSchema } from "../spec/ir.js";

const PlannedRequirementSchema = z.object({
  id: z.string(),
  preconditions: z.array(StepSchema).optional(),
  actions: z.array(StepSchema).optional(),
});

const PlannedSpecPatchSchema = z.object({
  run_goal: z.string().optional(),
  acceptance_policy: z
    .object({
      allow_model_assist: z.boolean().optional(),
    })
    .optional(),
  requirements: z.array(PlannedRequirementSchema).default([]),
  notes: z.string().optional(),
});
type PlannedSpecPatch = z.infer<typeof PlannedSpecPatchSchema>;

function toolSummary(tools: McpToolDescriptor[]) {
  // Keep the prompt compact but schema-aware.
  return tools
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    }))
    .slice(0, 200);
}

export async function planStepsWithLlm(opts: {
  spec: SpecIR;
  llm: LlmPolicy;
  targetUrl: string;
  chromeTools: McpToolDescriptor[];
}): Promise<{
  spec: SpecIR;
  meta: {
    durationMs: number;
    selectedModel?: string;
    patchedRequirements: number;
  };
}> {
  const startedAt = performance.now();

  // If no model, do nothing.
  if (opts.llm.provider !== "ollama") {
    return {
      spec: opts.spec,
      meta: {
        durationMs: Math.round(performance.now() - startedAt),
        patchedRequirements: 0,
      },
    };
  }

  const { selectedModel } = await ensureModelAvailable(opts.llm);

  const system =
    "You are an end-to-end web test planner. Produce ONLY JSON. No prose.";

  const prompt = [
    "Given a SpecIR (assertions) and the available Chrome DevTools MCP tools,",
    "add explicit procedural steps so the verifier can execute the test.",
    "",
    "You MUST output JSON matching this type:",
    "",
    "PlannedSpecPatch = {",
    "  requirements: Array<{",
    "    id: string,",
    "    preconditions?: Array<Step>,",
    "    actions?: Array<Step>",
    "  }>,",
    "  notes?: string",
    "}",
    "",
    'Step = { kind: "navigate"|"wait"|"click"|"type"|"fill"|"press"|"assert"|"tool_call", selector?: string, text?: string, key?: string, ms?: number, tool?: string, toolArgs?: object, notes?: string }',
    "",
    "Rules:",
    "- Prefer deterministic steps that can be executed via Chrome DevTools MCP.",
    "- Navigation is handled once per session by the executor bootstrap; only add kind=navigate if you truly need a different URL mid-test.",
    "- For visible_state assertions, add kind=wait using text to wait for key UI text before snapshotting.",
    '- If an assertion references a section title (e.g. "Recent runs"), add wait_for that exact text.',
    "- Use kind=tool_call to collect evidence required for judging, e.g.:",
    "  - tool_call { tool:'take_screenshot' } for appearance/layout checks",
    "  - tool_call { tool:'evaluate_script', toolArgs:{function:'() => ...'} } to extract computed styles or text",
    "  - tool_call { tool:'list_network_requests' } for network_request expectations",
    "  - tool_call { tool:'list_console_messages' } for console errors",
    "- Do NOT invent app-specific selectors unless the spec provides them. Prefer waiting/clicking by visible text.",
    "- Keep actions minimal; do not add exploratory browsing.",
    "- Output JSON only.",
    "",
    "TARGET URL:",
    opts.targetUrl,
    "",
    "AVAILABLE CHROME DEVTOOLS MCP TOOLS (name, description, inputSchema):",
    JSON.stringify(toolSummary(opts.chromeTools), null, 2),
    "",
    "SPEC IR:",
    JSON.stringify(opts.spec, null, 2),
  ].join("\n");

  let gen: Awaited<ReturnType<typeof ollamaGenerate>>;
  try {
    gen = await ollamaGenerate(opts.llm.ollamaHost, {
      model: selectedModel,
      system,
      prompt,
      format: "json",
      stream: false,
      options: { temperature: 0 },
    });
  } catch (cause) {
    // If planning fails, we should still run with whatever we have.
    return {
      spec: opts.spec,
      meta: {
        durationMs: Math.round(performance.now() - startedAt),
        selectedModel,
        patchedRequirements: 0,
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(gen.response);
  } catch (cause) {
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      "LLM step planner returned non-JSON.",
      {
        cause,
        details: { responsePreview: gen.response.slice(0, 500) },
      },
    );
  }

  const patch: PlannedSpecPatch = PlannedSpecPatchSchema.parse(raw);
  const byId = new Map(patch.requirements.map((r) => [r.id, r] as const));

  // Deterministic floor: if the LLM returns no steps for a requirement, we still
  // need a runnable plan. This is not “heuristic” UI exploration; it is a direct
  // compilation of expectations into concrete wait conditions.
  for (const r of opts.spec.requirements) {
    if (byId.has(r.id)) continue;
    const expectedText =
      r.expected_observables.find((o) => o.kind === "text_present" && o.text)
        ?.text ??
      r.expected_observables_sets?.generic?.find(
        (o) => o.kind === "text_present" && o.text,
      )?.text ??
      r.expected_observables_sets?.detailed?.find(
        (o) => o.kind === "text_present" && o.text,
      )?.text;
    byId.set(r.id, {
      id: r.id,
      preconditions: [
        // Navigation is handled once per session by the executor bootstrap.
        ...(expectedText
          ? [{ kind: "wait" as const, text: expectedText }]
          : []),
      ],
      actions: [],
    });
  }

  const patched = {
    ...opts.spec,
    requirements: opts.spec.requirements.map((r) => {
      const p = byId.get(r.id);
      if (!p) return r;
      return {
        ...r,
        ...(p.preconditions ? { preconditions: p.preconditions } : {}),
        ...(p.actions ? { actions: p.actions } : {}),
      };
    }),
  };

  // Validate full SpecIR again (defensive) so we never store invalid shape.
  const spec = SpecIRSchema.parse(patched);

  const patchedRequirements = byId.size;
  return {
    spec,
    meta: {
      durationMs: Math.round(performance.now() - startedAt),
      selectedModel,
      patchedRequirements,
    },
  };
}
