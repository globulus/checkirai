import type { ArtifactRef } from "../artifacts/types.js";
import type { RequirementResult, VerificationResult } from "./result.js";

export function synthesizeResult(opts: {
  requirementResults: RequirementResult[];
  artifacts: ArtifactRef[];
  toolCalls: number;
  sessions: number;
  durationMs: number;
  blockedReasons?: string[];
  meta?: Record<string, unknown>;
}): VerificationResult {
  const total = opts.requirementResults.length;
  const counts = { pass: 0, fail: 0, inconclusive: 0, blocked: 0 };
  for (const r of opts.requirementResults) {
    counts[r.verdict] += 1;
  }

  const overall_status: VerificationResult["overall_status"] =
    counts.fail > 0
      ? "fail"
      : counts.blocked > 0
        ? "blocked"
        : counts.pass === total && total > 0
          ? "pass"
          : "inconclusive";

  const confidence =
    total === 0
      ? 0
      : opts.requirementResults.reduce((sum, r) => sum + r.confidence, 0) /
        total;

  return {
    overall_status,
    coverage_summary: { total, ...counts },
    requirements: opts.requirementResults,
    artifacts: opts.artifacts,
    tool_trace_summary: {
      toolCalls: opts.toolCalls,
      sessions: opts.sessions,
      durationMs: opts.durationMs,
    },
    blocked_reasons: opts.blockedReasons,
    confidence,
    meta: opts.meta,
  };
}

export function synthesizeMarkdownSummary(result: VerificationResult): string {
  const lines: string[] = [];
  lines.push(`# Verification summary`);
  lines.push("");
  lines.push(`- **overall_status**: \`${result.overall_status}\``);
  lines.push(
    `- **coverage**: total=${result.coverage_summary.total} pass=${result.coverage_summary.pass} fail=${result.coverage_summary.fail} inconclusive=${result.coverage_summary.inconclusive} blocked=${result.coverage_summary.blocked}`,
  );
  lines.push(`- **confidence**: ${result.confidence.toFixed(2)}`);
  lines.push("");

  if (result.blocked_reasons?.length) {
    lines.push("## Blocked reasons");
    for (const r of result.blocked_reasons) lines.push(`- ${r}`);
    lines.push("");
  }

  lines.push("## Requirements");
  for (const r of result.requirements) {
    lines.push(
      `- **${r.requirement_id}**: \`${r.verdict}\` (confidence ${r.confidence.toFixed(2)})`,
    );
    if (r.why_failed_or_blocked)
      lines.push(`  - why: ${r.why_failed_or_blocked}`);
    if (r.repair_hint) lines.push(`  - hint: ${r.repair_hint}`);
  }
  lines.push("");
  return lines.join("\n");
}
