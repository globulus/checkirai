import type { VerificationResult } from "../core/result.js";
import { chatTextForRole } from "../llm/chatForRole.js";
import type { LlmPolicy } from "../llm/types.js";

/**
 * Post-run root-cause narrative from probe outcomes (best-effort).
 */
export async function runTriageMarkdown(opts: {
  policy: LlmPolicy;
  result: VerificationResult;
  hooks?: { onSelectedModel?: (model: string) => void };
}): Promise<string> {
  if (opts.policy.triage.provider === "none") {
    return "";
  }

  const system = [
    "You are a verification triage assistant.",
    "Read the structured run summary and explain likely root causes, cascading failures, and next debugging steps.",
    "Write clear Markdown. Do not invent evidence not present in the JSON.",
  ].join(" ");

  const prompt = [
    "VERIFICATION_RESULT_JSON:",
    JSON.stringify(
      {
        overall_status: opts.result.overall_status,
        coverage_summary: opts.result.coverage_summary,
        blocked_reasons: opts.result.blocked_reasons,
        requirements: opts.result.requirements.map((r) => ({
          id: r.requirement_id,
          verdict: r.verdict,
          confidence: r.confidence,
          why: r.why_failed_or_blocked,
          repair_hint: r.repair_hint,
        })),
        tool_trace_summary: opts.result.tool_trace_summary,
      },
      null,
      2,
    ),
  ].join("\n");

  const { responseText } = await chatTextForRole(
    opts.policy,
    "triage",
    { system, prompt },
    opts.hooks?.onSelectedModel
      ? { onSelectedModel: opts.hooks.onSelectedModel }
      : {},
  );
  return responseText.trim();
}
