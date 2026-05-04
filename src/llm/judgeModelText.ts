/**
 * Helpers for parsing judge LLM output when models emit reasoning/thinking
 * before JSON (e.g. DeepSeek-R1) or put rationale in alternate keys.
 */

const THINK_OPEN = "<" + "think" + ">";
const THINK_CLOSE = "<" + "/" + "think" + ">";
const REDACTED_THINK_OPEN = "<" + "redacted_thinking" + ">";
const REDACTED_THINK_CLOSE = "<" + "/" + "redacted_thinking" + ">";
const REASONING_OPEN = "<" + "reasoning" + ">";
const REASONING_CLOSE = "<" + "/" + "reasoning" + ">";
const REDACTED_REASON_OPEN = "<" + "redacted_reasoning" + ">";
const REDACTED_REASON_CLOSE = "<" + "/" + "redacted_reasoning" + ">";

/** Strip common reasoning wrappers so JSON extraction sees the verdict object. */
export function stripEmbeddedReasoningFromModelText(s: string): string {
  let t = s.trim();
  const patterns = [
    new RegExp(THINK_OPEN + "[\\s\\S]*?" + THINK_CLOSE, "gi"),
    new RegExp(REDACTED_THINK_OPEN + "[\\s\\S]*?" + REDACTED_THINK_CLOSE, "gi"),
    new RegExp(REASONING_OPEN + "[\\s\\S]*?" + REASONING_CLOSE, "gi"),
    new RegExp(
      REDACTED_REASON_OPEN + "[\\s\\S]*?" + REDACTED_REASON_CLOSE,
      "gi",
    ),
  ];
  for (let i = 0; i < 6; i++) {
    let next = t;
    for (const re of patterns) next = next.replace(re, "");
    next = next.trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

function normStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Merge `why` with alternate rationale keys models use instead of `why`.
 * Order: explicit why first, then longer reasoning fields.
 */
export function coalesceJudgmentWhyFromRecord(
  raw: Record<string, unknown>,
): string | undefined {
  const primary = normStr(raw.why);
  const reasoning =
    normStr(raw.reasoning) ??
    normStr(raw.chain_of_thought) ??
    normStr(raw.thinking) ??
    normStr(raw.rationale) ??
    normStr(raw.explanation);
  if (primary && reasoning && primary !== reasoning) {
    return `${primary}\n\n---\n\n${reasoning}`;
  }
  return primary ?? reasoning;
}

/**
 * Parse judge JSON from raw model text (may include thinking blocks or prose).
 * Never throws; returns a judgment-shaped object on failure.
 */
export function parseLooseJudgeJsonResponse(
  text: string | null | undefined,
): unknown {
  const stripped = stripEmbeddedReasoningFromModelText(
    typeof text === "string" ? text.trim() : "",
  );
  if (!stripped) {
    return {
      verdict: "inconclusive",
      confidence: 0.3,
      why: "Empty model response (no JSON).",
    };
  }
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const inner = fence?.[1]?.trim();
    if (inner) {
      try {
        return JSON.parse(inner) as unknown;
      } catch {
        // fall through
      }
    }
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as unknown;
      } catch {
        // fall through
      }
    }
    return {
      verdict: "inconclusive",
      confidence: 0.3,
      why: "Model returned non-JSON or unparseable output after stripping reasoning.",
    };
  }
}
