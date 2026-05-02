import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { ArtifactRef } from "../artifacts/types.js";
import type { RequirementResult } from "../core/result.js";
import type { ToolCallRecord } from "../executors/types.js";
import { ensureModelAvailable } from "../llm/modelOps.js";
import { ollamaGenerate } from "../llm/ollamaHttp.js";
import { remoteChatCompletion } from "../llm/remoteOpenAIClient.js";
import type { LlmPolicy } from "../llm/types.js";
import type { TestPlanIR } from "../planners/planIr.js";
import { VerifierError } from "../shared/errors.js";
import type { SpecIR } from "../spec/ir.js";
import { getExpectedObservables } from "../spec/observables.js";
import { readArtifactJson } from "./artifactReader.js";

const VerdictSchema = z.enum(["pass", "fail", "inconclusive", "blocked"]);

const JudgmentLooseSchema = z.object({
  verdict: z.unknown(),
  confidence: z.unknown().optional(),
  why: z.unknown().optional(),
  repair_hint: z.unknown().optional(),
});

function normalizeVerdict(v: unknown): z.infer<typeof VerdictSchema> {
  const s = typeof v === "string" ? v.toLowerCase().trim() : "";
  if (s === "pass" || s === "fail" || s === "inconclusive" || s === "blocked")
    return s;
  return "inconclusive";
}

function normalizeConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0.5;
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function normStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

type SingleJudgment = {
  verdict: z.infer<typeof VerdictSchema>;
  confidence: number;
  why?: string;
  repair_hint?: string;
};

function normalizeJudgment(raw: unknown): SingleJudgment {
  const loose = JudgmentLooseSchema.parse(raw);
  const why = normStr(loose.why);
  const repair_hint = normStr(loose.repair_hint);
  return {
    verdict: normalizeVerdict(loose.verdict),
    confidence: normalizeConfidence(loose.confidence),
    ...(why ? { why } : {}),
    ...(repair_hint ? { repair_hint } : {}),
  };
}

function truncate(s: string, max = 12000) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[truncated ${s.length - max} chars]`;
}

function sanitizeExpected(exps: unknown): unknown {
  try {
    const arr = Array.isArray(exps)
      ? (exps as Array<Record<string, unknown>>)
      : [];
    return arr.map((e) => {
      const pattern = e.pattern;
      if (typeof pattern === "string" && pattern.includes("\u0008")) {
        return { ...e, pattern: pattern.replace(/\u0008/g, "\\\\b") };
      }
      return e;
    });
  } catch {
    return exps;
  }
}

function collectGlobalEvidence(opts: {
  toolCalls: ToolCallRecord[];
  artifacts: ArtifactRef[];
  artifactRootDir: string;
}): { snapshotText?: string; toolOutputs: unknown[] } {
  const artifactsById = new Map(opts.artifacts.map((a) => [a.id, a] as const));
  const toolOutputArtifacts = opts.toolCalls
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
      const st = (obj as { snapshotText?: unknown } | null)?.snapshotText;
      if (typeof st === "string") snapshotText = st;
    } catch {
      // ignore
    }
  }
  return {
    ...(snapshotText ? { snapshotText } : {}),
    toolOutputs,
  };
}

function majorityAggregate(judgments: SingleJudgment[]): SingleJudgment {
  const counts = new Map<string, number>();
  for (const j of judgments) {
    counts.set(j.verdict, (counts.get(j.verdict) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topVerdict, topCount] = sorted[0] ?? ["inconclusive", 0];
  const winners = judgments.filter((j) => j.verdict === topVerdict);
  const confidence =
    winners.length === 0
      ? 0.3
      : winners.reduce((s, j) => s + j.confidence, 0) / winners.length;
  const why = winners.map((w) => w.why).find(Boolean);
  const repair_hint = winners.map((w) => w.repair_hint).find(Boolean);

  // If no majority (e.g. 1/1/1), return inconclusive.
  if (topCount === 1 && counts.size > 1) {
    return { verdict: "inconclusive", confidence: 0.3 };
  }
  return {
    verdict: topVerdict as z.infer<typeof VerdictSchema>,
    confidence: Math.max(0, Math.min(1, confidence)),
    ...(why ? { why } : {}),
    ...(repair_hint ? { repair_hint } : {}),
  };
}

/** Parse model output as JSON; never throw — bad/empty output becomes inconclusive judgment shape. */
function safeParseJudgmentJsonResponse(
  text: string | undefined | null,
): unknown {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) {
    return {
      verdict: "inconclusive",
      confidence: 0.3,
      why: "Empty model response (no JSON).",
    };
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const inner = fence?.[1]?.trim();
    if (inner) {
      try {
        return JSON.parse(inner) as unknown;
      } catch {
        // fall through
      }
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as unknown;
      } catch {
        // fall through
      }
    }
    return {
      verdict: "inconclusive",
      confidence: 0.3,
      why: "Model returned non-JSON or unparseable output.",
    };
  }
}

async function llmCallJson(opts: {
  llm: LlmPolicy;
  system: string;
  prompt: string;
  temperature: number;
  onSelectedModel?: (model: string) => void;
}): Promise<unknown> {
  if (opts.llm.provider === "ollama") {
    const { selectedModel } = await ensureModelAvailable(opts.llm);
    opts.onSelectedModel?.(selectedModel);
    const gen = await ollamaGenerate(opts.llm.ollamaHost, {
      model: selectedModel,
      system: opts.system,
      prompt: opts.prompt,
      format: "json",
      stream: false,
      options: { temperature: opts.temperature },
    });
    return safeParseJudgmentJsonResponse(gen.response);
  }
  if (opts.llm.provider === "remote") {
    if (!opts.llm.remoteBaseUrl || !opts.llm.remoteApiKey) {
      throw new VerifierError(
        "CONFIG_ERROR",
        "Remote LLM policy missing remoteBaseUrl/remoteApiKey.",
      );
    }
    const model = opts.llm.ollamaModel || "gpt-4.1-mini";
    const out = await remoteChatCompletion({
      baseUrl: opts.llm.remoteBaseUrl,
      apiKey: opts.llm.remoteApiKey,
      model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
      temperature: opts.temperature,
    });
    return safeParseJudgmentJsonResponse(out.content);
  }
  throw new VerifierError(
    "CONFIG_ERROR",
    "LLM provider is none; cannot judge.",
  );
}

async function judgeRequirementAttempt(opts: {
  llm: LlmPolicy;
  attempt: number;
  requirement: { id: string; source_text: string };
  expected: unknown;
  rubric?: string;
  evidence: { snapshotText?: string; toolOutputs: unknown[] };
  onSelectedModel?: (model: string) => void;
}): Promise<SingleJudgment> {
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
    "- Prefer using structured evidence in toolOutputs.parsedJson when available.",
    "- If expected contains a regex pattern (kind='text_present', pattern), apply it to snapshotText when present.",
    "",
    `ATTEMPT: ${opts.attempt}`,
    `REQUIREMENT_ID: ${opts.requirement.id}`,
    `REQUIREMENT_TEXT: ${opts.requirement.source_text}`,
    "",
    "EXPECTED_OBSERVABLES:",
    JSON.stringify(opts.expected, null, 2),
    "",
    "RUBRIC (optional):",
    opts.rubric ?? "(none)",
    "",
    "SNAPSHOT_TEXT (optional):",
    opts.evidence.snapshotText
      ? truncate(opts.evidence.snapshotText)
      : "(missing)",
    "",
    "TOOL_OUTPUTS (truncated):",
    truncate(JSON.stringify(opts.evidence.toolOutputs, null, 2), 12000),
  ].join("\n");

  const raw = await llmCallJson({
    llm: opts.llm,
    system,
    prompt,
    temperature: opts.attempt === 1 ? 0 : 0.15,
    ...(opts.onSelectedModel ? { onSelectedModel: opts.onSelectedModel } : {}),
  });
  return normalizeJudgment(raw);
}

function tryDeterministicFromEvidence(opts: {
  requirementText: string;
  expected: unknown;
  snapshotText?: string;
  toolOutputs: unknown[];
}): SingleJudgment | undefined {
  const exps = Array.isArray(opts.expected)
    ? (opts.expected as Array<Record<string, unknown>>)
    : [];
  const snap = opts.snapshotText;

  // If we have snapshot text, prefer deterministic evaluation for text expectations.
  if (snap) {
    // Regex expectation: text_present.pattern
    const patExp = exps.find(
      (e) => e.kind === "text_present" && typeof e.pattern === "string",
    );
    if (patExp) {
      const pattern = String(patExp.pattern);

      // Special-case: "current time of day" should refer to a dedicated "now" display,
      // not incidental timestamps in history tables.
      if (/\bcurrent time of day\b/i.test(opts.requirementText)) {
        const hasClockLabel = /\b(current time|time of day|now)\b/i.test(snap);
        if (!hasClockLabel) {
          return {
            verdict: "fail",
            confidence: 0.85,
            why: "No dedicated 'current time/now' indicator found in snapshot; requirement expects a current-time display.",
          };
        }
      }

      try {
        const re = new RegExp(pattern);
        const ok = re.test(snap);
        return {
          verdict: ok ? "pass" : "fail",
          confidence: 0.9,
          why: ok
            ? `Regex matched snapshot: /${pattern}/`
            : `Regex did not match snapshot: /${pattern}/`,
        };
      } catch {
        // invalid regex; fall through to LLM
      }
    }

    // Direct text expectations: text_present.text
    const textExps = exps.filter(
      (e) =>
        e.kind === "text_present" &&
        typeof e.text === "string" &&
        e.text.trim(),
    );
    if (textExps.length) {
      const missing = textExps
        .map((e) => String(e.text))
        .filter((t) => !snap.toLowerCase().includes(t.toLowerCase()));
      if (missing.length) {
        return {
          verdict: "fail",
          confidence: 0.9,
          why: `Missing expected text in snapshot: ${missing
            .map((m) => JSON.stringify(m))
            .join(", ")}`,
        };
      }
      return {
        verdict: "pass",
        confidence: 0.9,
        why: "All expected text found in snapshot.",
      };
    }
  }

  // Button color check (green) using evaluate_script.parsedJson evidence.
  if (
    /\bbuttons?\b/i.test(opts.requirementText) &&
    /\bgreen\b/i.test(opts.requirementText)
  ) {
    const parseJsonFence = (text: string): unknown | undefined => {
      const m = text.match(/```json\s*([\s\S]*?)\s*```/i);
      const payload = m?.[1]?.trim();
      if (!payload) return undefined;
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return undefined;
      }
    };

    const parsedArrays: unknown[] = [];
    for (const t of opts.toolOutputs) {
      const tt = t as { parsedJson?: unknown; responseText?: unknown } | null;
      const pj = tt?.parsedJson;
      if (Array.isArray(pj)) parsedArrays.push(pj);

      const rt = tt?.responseText;
      if (typeof rt === "string") {
        const parsed = parseJsonFence(rt);
        if (Array.isArray(parsed)) parsedArrays.push(parsed);
      }
    }
    const rows =
      (parsedArrays[0] as Array<Record<string, unknown>> | undefined) ?? [];
    if (rows.length) {
      const colors = rows
        .flatMap((r) => [
          typeof r.backgroundColor === "string" ? r.backgroundColor : "",
          typeof r.color === "string" ? r.color : "",
        ])
        .filter(Boolean);
      const anyGreenish = colors.some((c) => {
        if (c.toLowerCase().includes("green")) return true;
        const m = c.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
        if (!m) return false;
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        return g > r + 20 && g > b + 20 && g >= 120;
      });
      return {
        verdict: anyGreenish ? "pass" : "fail",
        confidence: 0.85,
        why: anyGreenish
          ? "Computed button styles include green-ish color."
          : "Computed button styles do not include green-ish color.",
      };
    }
  }

  return undefined;
}

export async function judgeWithSelfConsistency(opts: {
  llm: LlmPolicy;
  spec: SpecIR;
  plan: TestPlanIR;
  toolCalls: ToolCallRecord[];
  artifacts: ArtifactRef[];
  artifactRootDir: string;
  attempts?: number; // default 3
  onSelectedModel?: (model: string) => void;
}): Promise<{
  results: RequirementResult[];
  meta: { durationMs: number; attempted: number };
}> {
  const startedAt = performance.now();
  const attempts = typeof opts.attempts === "number" ? opts.attempts : 3;

  if (opts.llm.provider === "none") {
    throw new VerifierError(
      "CONFIG_ERROR",
      "LLM provider is none; cannot judge.",
    );
  }

  const evidence = collectGlobalEvidence({
    toolCalls: opts.toolCalls,
    artifacts: opts.artifacts,
    artifactRootDir: opts.artifactRootDir,
  });

  const rubricByReq = new Map(
    opts.plan.rubric.map((r) => [r.requirementId, r.rubric] as const),
  );

  const results: RequirementResult[] = [];
  for (const r of opts.spec.requirements) {
    const expected = sanitizeExpected(getExpectedObservables(opts.spec, r));

    // High-signal deterministic fast-path when we already have adequate evidence.
    const det = tryDeterministicFromEvidence({
      requirementText: r.source_text,
      expected,
      ...(evidence.snapshotText ? { snapshotText: evidence.snapshotText } : {}),
      toolOutputs: evidence.toolOutputs,
    });
    if (det) {
      results.push({
        requirement_id: r.id,
        verdict: det.verdict,
        confidence: det.confidence,
        judgment_mode: "model_assisted",
        evidence_refs: [],
        expected: {
          source_text: r.source_text,
          expected_observables: expected,
        },
        ...(det.why ? { why_failed_or_blocked: det.why } : {}),
      });
      continue;
    }

    const judgments: SingleJudgment[] = [];
    for (let i = 1; i <= attempts; i++) {
      judgments.push(
        await judgeRequirementAttempt({
          llm: opts.llm,
          attempt: i,
          requirement: { id: r.id, source_text: r.source_text },
          expected,
          ...(rubricByReq.get(r.id) ? { rubric: rubricByReq.get(r.id)! } : {}),
          evidence,
          ...(opts.onSelectedModel ? { onSelectedModel: opts.onSelectedModel } : {}),
        }),
      );
    }
    const agg = majorityAggregate(judgments);
    results.push({
      requirement_id: r.id,
      verdict: agg.verdict === "blocked" ? "blocked" : agg.verdict,
      confidence: agg.confidence,
      judgment_mode: "model_assisted",
      evidence_refs: [],
      expected: { source_text: r.source_text, expected_observables: expected },
      ...(agg.why ? { why_failed_or_blocked: agg.why } : {}),
      ...(agg.repair_hint ? { repair_hint: agg.repair_hint } : {}),
    });
  }

  return {
    results,
    meta: {
      durationMs: Math.round(performance.now() - startedAt),
      attempted: attempts,
    },
  };
}
