import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { ArtifactRef } from "../artifacts/types.js";
import type { RequirementResult } from "../core/result.js";
import type { ToolCallRecord } from "../executors/types.js";
import { ensureModelAvailable } from "../llm/modelOps.js";
import { ollamaGenerate } from "../llm/ollamaHttp.js";
import { remoteChatCompletion } from "../llm/remoteOpenAIClient.js";
import type { LlmPolicy } from "../llm/types.js";
import type { ProbePlan } from "../planners/types.js";
import { VerifierError } from "../shared/errors.js";
import type { SpecIR } from "../spec/ir.js";
import { getExpectedObservables } from "../spec/observables.js";
import { readArtifactJson } from "./artifactReader.js";

const LlmVerdictSchema = z.enum(["pass", "fail", "inconclusive"]);

// Be tolerant: models sometimes output slightly off-schema values (nulls, extra keys,
// or verdict variants). We'll normalize to our strict internal shape.
const LlmJudgmentLooseSchema = z.object({
  verdict: z.unknown(),
  confidence: z.unknown().optional(),
  why: z.unknown().optional(),
  repair_hint: z.unknown().optional(),
});
type LlmJudgment = {
  verdict: z.infer<typeof LlmVerdictSchema>;
  confidence: number;
  why?: string;
  repair_hint?: string;
};

function normalizeJudgment(
  raw: z.infer<typeof LlmJudgmentLooseSchema>,
): LlmJudgment {
  const verdictStr =
    typeof raw.verdict === "string" ? raw.verdict.toLowerCase().trim() : "";
  const verdict =
    verdictStr === "pass" ||
    verdictStr === "fail" ||
    verdictStr === "inconclusive"
      ? (verdictStr as z.infer<typeof LlmVerdictSchema>)
      : "inconclusive";

  const confNum =
    typeof raw.confidence === "number"
      ? raw.confidence
      : typeof raw.confidence === "string"
        ? Number(raw.confidence)
        : 0.5;
  const confidence = Number.isFinite(confNum)
    ? Math.max(0, Math.min(1, confNum))
    : 0.5;

  const why =
    typeof raw.why === "string" && raw.why.trim() ? raw.why.trim() : undefined;
  const repair_hint =
    typeof raw.repair_hint === "string" && raw.repair_hint.trim()
      ? raw.repair_hint.trim()
      : undefined;

  return {
    verdict,
    confidence,
    ...(why ? { why } : {}),
    ...(repair_hint ? { repair_hint } : {}),
  };
}

export type LlmJudgeSecondPassInput = {
  spec: SpecIR;
  plan: ProbePlan;
  toolCalls: ToolCallRecord[];
  artifacts: ArtifactRef[];
  artifactRootDir: string;
  llm: LlmPolicy;
  /**
   * Only these requirement ids will be considered for LLM judging.
   * Use this to target inconclusive results.
   */
  requirementIds: string[];
};

function extractSnapshotTextFromToolOutput(obj: unknown): string | undefined {
  const o = obj as { snapshotText?: unknown } | null;
  return typeof o?.snapshotText === "string" ? o.snapshotText : undefined;
}

function collectEvidence(opts: {
  requirementId: string;
  plan: ProbePlan;
  toolCalls: ToolCallRecord[];
  artifacts: ArtifactRef[];
  artifactRootDir: string;
}): { snapshotText?: string; toolOutputs: unknown[] } {
  const probeIds: string[] = [];
  for (const s of opts.plan.sessions) {
    for (const p of s.probes) {
      if (p.requirementId === opts.requirementId) probeIds.push(p.id);
    }
  }

  const calls = opts.toolCalls.filter(
    (t) => t.probeId && probeIds.includes(t.probeId),
  );
  const artifactsById = new Map(opts.artifacts.map((a) => [a.id, a] as const));

  const toolOutputArtifacts = calls
    .map((c) => c.outputArtifactId)
    .filter(Boolean)
    .map((id) => artifactsById.get(id as string))
    .filter(Boolean) as ArtifactRef[];

  const toolOutputs: unknown[] = [];
  let snapshotText: string | undefined;

  for (const a of toolOutputArtifacts) {
    try {
      const obj = readArtifactJson<unknown>(opts.artifactRootDir, a);
      toolOutputs.push(obj);
      const st = extractSnapshotTextFromToolOutput(obj);
      if (st) snapshotText = st;
    } catch {
      // ignore
    }
  }

  return {
    toolOutputs,
    ...(snapshotText ? { snapshotText } : {}),
  };
}

function truncate(s: string, max = 12000) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[truncated ${s.length - max} chars]`;
}

function sanitizeExpected(exps: unknown): unknown {
  // Some upstream JSON encoders turn `\b` into a literal backspace (U+0008).
  // For regex-based expectations, normalize that back to a portable escape sequence.
  try {
    const arr = Array.isArray(exps)
      ? (exps as Array<Record<string, unknown>>)
      : [];
    const bs = String.fromCharCode(8);
    return arr.map((e) => {
      const pattern = e.pattern;
      if (typeof pattern === "string" && pattern.includes(bs)) {
        return { ...e, pattern: pattern.split(bs).join("\\\\b") };
      }
      return e;
    });
  } catch {
    return exps;
  }
}

function tryDeterministicSecondPass(opts: {
  requirementText: string;
  expected: unknown;
  snapshotText?: string;
  toolOutputs: unknown[];
}): { verdict: "pass" | "fail"; why: string; confidence: number } | undefined {
  // 1) Regex-based text_present.pattern
  const exps = Array.isArray(opts.expected)
    ? (opts.expected as Array<Record<string, unknown>>)
    : [];
  const patExp = exps.find(
    (e) => e.kind === "text_present" && typeof e.pattern === "string",
  );
  if (patExp && opts.snapshotText) {
    const pattern = String(patExp.pattern);
    try {
      const re = new RegExp(pattern);
      const ok = re.test(opts.snapshotText);
      return {
        verdict: ok ? "pass" : "fail",
        why: ok
          ? `Regex matched in snapshot: /${pattern}/`
          : `Regex did not match snapshot: /${pattern}/`,
        confidence: 0.85,
      };
    } catch {
      // ignore invalid regex; fall back to LLM
    }
  }

  // 2) Button color checks via evaluate_script.parsedJson evidence
  if (
    /\bbuttons?\b/i.test(opts.requirementText) &&
    /\bgreen\b/i.test(opts.requirementText)
  ) {
    const parsedArrays: unknown[] = [];
    for (const t of opts.toolOutputs) {
      const pj = (t as { parsedJson?: unknown } | null)?.parsedJson;
      if (Array.isArray(pj)) parsedArrays.push(pj);
    }
    const rows =
      (parsedArrays[0] as Array<Record<string, unknown>> | undefined) ?? [];
    if (rows.length) {
      const colors = rows
        .map((r) => (typeof r.color === "string" ? r.color : ""))
        .filter(Boolean);
      const anyGreenish = colors.some((c) => {
        if (c.toLowerCase().includes("green")) return true;
        const m = c.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
        if (!m) return false;
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        // crude heuristic: green channel dominates and is meaningfully high
        return g > r + 20 && g > b + 20 && g >= 120;
      });
      return {
        verdict: anyGreenish ? "pass" : "fail",
        why: anyGreenish
          ? "Computed button styles include green-ish color."
          : "Computed button styles do not include green-ish color.",
        confidence: 0.8,
      };
    }
  }

  return undefined;
}

async function judgeOneWithLlm(opts: {
  llm: LlmPolicy;
  model: string;
  requirement: { id: string; source_text: string };
  expected: unknown;
  snapshotText?: string;
  toolOutputs: unknown[];
}): Promise<LlmJudgment> {
  const system =
    "You are a strict verifier. Decide pass/fail/inconclusive based ONLY on provided evidence. Output JSON only.";

  const prompt = [
    "Return JSON matching:",
    "{ verdict: 'pass'|'fail'|'inconclusive', confidence: number, why?: string, repair_hint?: string }",
    "",
    "Rules:",
    "- Use verdict=pass only if evidence clearly satisfies the expectation.",
    "- Use verdict=fail only if evidence clearly contradicts the expectation.",
    "- Otherwise verdict=inconclusive.",
    "- If expected_observables contains {kind:'text_present', pattern:'...'}, treat it as a REGEX applied to A11Y_SNAPSHOT_TEXT.",
    "  - If A11Y_SNAPSHOT_TEXT is present and the regex does NOT match anywhere => verdict MUST be 'fail'.",
    "  - If it matches => verdict MUST be 'pass'.",
    "- For appearance/style checks (e.g. requirement text contains 'buttons' and a color like 'green'):",
    "  - If TOOL_OUTPUTS includes an evaluate_script result containing computed style fields like color/backgroundColor for buttons,",
    "    you MUST decide pass/fail based on those values (do not return inconclusive).",
    "  - If the evidence lacks computed styles, you may use screenshots only as weak evidence and should usually return inconclusive.",
    "- Confidence should reflect certainty from evidence quality.",
    "- Do not invent UI state not present in evidence.",
    "",
    `REQUIREMENT_ID: ${opts.requirement.id}`,
    `REQUIREMENT_TEXT: ${opts.requirement.source_text}`,
    "",
    "EXPECTED_OBSERVABLES (JSON):",
    JSON.stringify(opts.expected, null, 2),
    "",
    "A11Y_SNAPSHOT_TEXT (if present):",
    opts.snapshotText ? truncate(opts.snapshotText) : "(missing)",
    "",
    "TOOL_OUTPUTS (JSON, may include errors or screenshot refs):",
    truncate(JSON.stringify(opts.toolOutputs, null, 2), 12000),
  ].join("\n");

  let responseText: string;
  if (opts.llm.provider === "ollama") {
    const gen = await ollamaGenerate(opts.llm.ollamaHost, {
      model: opts.model,
      system,
      prompt,
      format: "json",
      stream: false,
      options: { temperature: 0 },
    });
    responseText = gen.response;
  } else if (opts.llm.provider === "remote") {
    if (!opts.llm.remoteBaseUrl?.trim() || !opts.llm.remoteApiKey?.trim()) {
      throw new VerifierError(
        "CONFIG_ERROR",
        "Remote LLM policy missing remoteBaseUrl/remoteApiKey.",
      );
    }
    const out = await remoteChatCompletion({
      baseUrl: opts.llm.remoteBaseUrl.trim(),
      apiKey: opts.llm.remoteApiKey.trim(),
      model: opts.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: 0,
    });
    responseText = out.content;
  } else {
    throw new VerifierError(
      "CONFIG_ERROR",
      "Unsupported LLM provider for judge.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(responseText);
  } catch (cause) {
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      "LLM judge returned non-JSON.",
      {
        cause,
        details: { responsePreview: responseText.slice(0, 500) },
      },
    );
  }
  const loose = LlmJudgmentLooseSchema.parse(raw);
  return normalizeJudgment(loose);
}

export async function judgeLlmSecondPass(
  input: LlmJudgeSecondPassInput,
  seedResults: RequirementResult[],
  opts?: { onSelectedModel?: (model: string) => void },
): Promise<{ results: RequirementResult[]; meta: { durationMs: number } }> {
  const startedAt = performance.now();

  if (input.llm.provider !== "ollama" && input.llm.provider !== "remote") {
    return {
      results: seedResults,
      meta: { durationMs: Math.round(performance.now() - startedAt) },
    };
  }

  const selectedModel =
    input.llm.provider === "ollama"
      ? (await ensureModelAvailable(input.llm)).selectedModel
      : input.llm.remoteModel?.trim() || "gpt-4o-mini";
  opts?.onSelectedModel?.(selectedModel);

  const byReqId = new Map(
    seedResults.map((r) => [r.requirement_id, r] as const),
  );

  for (const reqId of input.requirementIds) {
    const base = byReqId.get(reqId);
    if (!base) continue;
    if (base.verdict !== "inconclusive") continue;

    const req = input.spec.requirements.find((r) => r.id === reqId);
    if (!req) continue;

    const expected = sanitizeExpected(getExpectedObservables(input.spec, req));
    const evidence = collectEvidence({
      requirementId: reqId,
      plan: input.plan,
      toolCalls: input.toolCalls,
      artifacts: input.artifacts,
      artifactRootDir: input.artifactRootDir,
    });

    // If we have zero evidence, keep inconclusive.
    if (!evidence.snapshotText && evidence.toolOutputs.length === 0) continue;

    const det = tryDeterministicSecondPass({
      requirementText: req.source_text,
      expected,
      ...(evidence.snapshotText ? { snapshotText: evidence.snapshotText } : {}),
      toolOutputs: evidence.toolOutputs,
    });
    if (det) {
      byReqId.set(reqId, {
        ...base,
        verdict: det.verdict,
        confidence: det.confidence,
        judgment_mode: "model_assisted",
        why_failed_or_blocked: det.why,
      });
      continue;
    }

    const llmJudgment = await judgeOneWithLlm({
      llm: input.llm,
      model: selectedModel,
      requirement: { id: reqId, source_text: req.source_text },
      expected,
      ...(evidence.snapshotText ? { snapshotText: evidence.snapshotText } : {}),
      toolOutputs: evidence.toolOutputs,
    });

    // Merge result; only override if the model made a stronger call.
    if (llmJudgment.verdict === "inconclusive") continue;

    byReqId.set(reqId, {
      ...base,
      verdict: llmJudgment.verdict,
      confidence: llmJudgment.confidence,
      judgment_mode: "model_assisted",
      ...(llmJudgment.why ? { why_failed_or_blocked: llmJudgment.why } : {}),
      ...(llmJudgment.repair_hint
        ? { repair_hint: llmJudgment.repair_hint }
        : {}),
    });
  }

  return {
    results: input.spec.requirements
      .map((r) => byReqId.get(r.id))
      .filter(Boolean) as RequirementResult[],
    meta: { durationMs: Math.round(performance.now() - startedAt) },
  };
}
