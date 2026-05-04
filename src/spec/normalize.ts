import { performance } from "node:perf_hooks";
import { chatJsonForRole } from "../llm/chatForRole.js";
import type { LlmPolicy } from "../llm/types.js";
import {
  type ObservableExpectationIR,
  type SpecIR,
  SpecIRSchema,
} from "./ir.js";
import {
  OBSERVABLE_KINDS_PROMPT,
  REQUIREMENT_TYPES_PROMPT,
} from "./llmPromptConstants.js";

export type SpecNormalizationMeta =
  | {
      mode: "heuristic";
      provider: "none" | "ollama" | "remote" | "other";
      selectedModel?: string;
      durationMs: number;
      specChars: number;
      usedFallbackHeuristics: boolean;
    }
  | {
      mode: "ollama";
      provider: "ollama";
      selectedModel: string;
      durationMs: number;
      specChars: number;
      usedFallbackHeuristics: boolean;
      retriedWithFallbackModel: boolean;
    }
  | {
      mode: "remote";
      provider: "remote";
      selectedModel: string;
      durationMs: number;
      specChars: number;
      usedFallbackHeuristics: boolean;
      retriedWithFallbackModel?: boolean;
    };

function extractQuotedStrings(s: string): string[] {
  const out: string[] = [];
  // Straight quotes
  for (const m of s.matchAll(/"([^"]+)"/g)) {
    if (m[1]) out.push(m[1].trim());
  }
  // Curly quotes (common in markdown specs)
  for (const m of s.matchAll(/“([^”]+)”/g)) {
    if (m[1]) out.push(m[1].trim());
  }
  return [...new Set(out)].filter((v): v is string => Boolean(v));
}

function inferTextNeedlesFromBullet(source: string): string[] {
  const quoted = extractQuotedStrings(source);
  if (quoted.length > 0) return quoted;

  // Heuristic: "X shows Y" / "X should show Y"
  const m = source.match(/\b(?:shows|show|should show)\b\s+(.+)$/i);
  if (m?.[1]) {
    return [m[1].replace(/\s*\(.*?\)\s*$/g, "").trim()].filter(Boolean);
  }

  // Fallback: use the whole bullet as a text needle.
  return [source];
}

function deriveGenericObservablesFromSource(
  source_text: string,
  detailed: ObservableExpectationIR[],
): ObservableExpectationIR[] {
  // Preserve any explicit URL intent if present in detailed.
  const url = detailed.find((o) => o.kind === "url_matches")?.url;
  if (url) return [{ kind: "url_matches", url }];

  // For appearance constraints, keep it generic-but-structural (no css metadata).
  if (
    /\bbuttons?\b/i.test(source_text) &&
    /\b(green|red|blue|purple|orange|yellow|black|white)\b/i.test(source_text)
  ) {
    const selector =
      detailed.find((o) => o.kind === "element_visible")?.selector ?? "button";
    return [{ kind: "element_visible", selector }];
  }

  if (/\bcurrent time of day\b/i.test(source_text)) {
    return [{ kind: "time_present" }];
  }

  const needles = inferTextNeedlesFromBullet(source_text);
  return needles
    .filter(Boolean)
    .map((text) => ({ kind: "text_present" as const, text }));
}

function normalizationSystem(): string {
  return [
    "You are a spec normalizer for an automated verification engine.",
    "Output: a single JSON object matching SpecIR. No markdown fences, no commentary, no trailing text.",
    "Goal: each bullet becomes a requirement with typed, checkable observables—never paraphrase dynamic UI state as a literal text_present string unless the UI is supposed to show that exact phrase.",
  ].join(" ");
}

function buildNormalizationPrompt(markdownTrimmed: string): string {
  return [
    "Convert the markdown spec below into JSON that matches this TypeScript type:",
    "",
    `SpecIR = {`,
    `  run_goal: string,`,
    `  requirements: Array<{`,
    `    id: string,`,
    `    source_text: string,`,
    `    type: ${REQUIREMENT_TYPES_PROMPT},`,
    `    priority: "must"|"should"|"could",`,
    `    expected_observables_sets?: {`,
    `      generic: Array<Observable>,`,
    `      detailed: Array<Observable>`,
    `    },`,
    `    expected_observables: Array<{`,
    `      kind: ${OBSERVABLE_KINDS_PROMPT},`,
    `      selector?: string, role?: string, text?: string, url?: string, pattern?: string, metadata?: object`,
    `    }>,`,
    `    notes?: string`,
    `  }>,`,
    `  acceptance_policy: { strictness: "strict"|"balanced"|"lenient", allow_model_assist: boolean, observable_detail?: "generic"|"detailed"|"both" }`,
    `}`,
    "",
    "Rules:",
    "- Always produce at least one expected_observable per requirement.",
    "- Prefer producing BOTH: expected_observables_sets.generic and expected_observables_sets.detailed.",
    "- In generic, prefer text_present/role_present/url_matches (avoid brittle CSS selectors).",
    "- In detailed, include selectors and metadata when it improves precision.",
    "- DYNAMIC / DERIVED UI STATE: If the bullet asks for something that changes over time (clock, 'current time', 'today’s date', live counters), do NOT use text_present for a descriptive sentence about that fact.",
    "  Use kind='time_present' (no extra fields) when the intent is 'a clock or formatted time is visible'. Set type='visible_state'.",
    "  If the spec names an exact string that must appear verbatim, text_present is appropriate.",
    "- APPEARANCE / STYLING: For colors, spacing, typography, layout, set type='appearance' and use kind='element_visible' with selector plus metadata.css.",
    "  For solid buttons ('buttons are green'), prefer metadata.css.backgroundColor with the named color, not text_present and not css.color alone.",
    "  Never satisfy a styling requirement with text_present of the color word or a made-up sentence like 'Buttons are green'.",
    "- If a bullet says '(intentional fail)', set priority='could'.",
    "- Keep source_text as the bullet text (without the leading dash).",
    "- Output JSON only.",
    "",
    "Examples (shape only; ids and run_goal in your answer must cover the full MARKDOWN SPEC):",
    "",
    "Bullet: Dashboard should show the current time of day",
    "Good requirement:",
    `{"id":"req-10","source_text":"Dashboard should show the current time of day","type":"visible_state","priority":"must","expected_observables":[{"kind":"time_present"}],"expected_observables_sets":{"generic":[{"kind":"time_present"}],"detailed":[{"kind":"time_present"}]}}`,
    "",
    "Bullet: Primary buttons should use a green background",
    "Good requirement:",
    `{"id":"req-9","source_text":"Primary buttons should use a green background","type":"appearance","priority":"must","expected_observables":[{"kind":"element_visible","selector":"button","metadata":{"css":{"backgroundColor":"green"}}}],"expected_observables_sets":{"generic":[{"kind":"element_visible","selector":"button"}],"detailed":[{"kind":"element_visible","selector":"button","metadata":{"css":{"backgroundColor":"green"}}}]}}`,
    "",
    "MARKDOWN SPEC:",
    markdownTrimmed,
  ].join("\n");
}

function finalizeParsedSpecIr(raw: unknown): SpecIR {
  const parsed = SpecIRSchema.parse(raw);
  return ensureDualObservableSets(
    SpecIRSchema.parse({
      ...parsed,
      requirements: parsed.requirements.map((r) =>
        postProcessRequirement({
          ...r,
          ...(r.notes ? { notes: r.notes } : {}),
        }),
      ),
    }),
  );
}

function ensureDualObservableSets(spec: SpecIR): SpecIR {
  return SpecIRSchema.parse({
    ...spec,
    requirements: spec.requirements.map((req) => {
      const detailed = req.expected_observables ?? [];
      const existing = req.expected_observables_sets;
      const generic = existing?.generic?.length
        ? existing.generic
        : deriveGenericObservablesFromSource(req.source_text, detailed);

      return {
        ...req,
        expected_observables_sets: {
          generic,
          detailed: existing?.detailed?.length ? existing.detailed : detailed,
        },
        // Keep top-level expected_observables stable by default.
        expected_observables: generic,
      };
    }),
  });
}

/**
 * MVP unstructured markdown → SpecIR.
 *
 * Heuristic rules:
 * - Each non-empty bullet line becomes a `must` requirement.
 * - Headings are ignored for now.
 *
 * This will be replaced with a richer normalizer (and optional LLM assist) later.
 */
export function normalizeMarkdownToSpecIR(markdown: string): SpecIR {
  const lines = markdown.split(/\r?\n/).map((l) => l.trim());
  const bullets = lines.filter((l) => /^(-|\*|\d+\.)\s+/.test(l));

  const requirements = bullets.map((l, idx) => {
    const source = l.replace(/^(-|\*|\d+\.)\s+/, "").trim();
    const isIntentionalFail = /\bintentional fail\b/i.test(source);
    const base = {
      id: `req-${idx + 1}`,
      source_text: source,
      type: "structure",
      priority: isIntentionalFail ? "could" : "must",
      expected_observables: inferTextNeedlesFromBullet(source).map((text) => ({
        kind: "text_present" as const,
        text,
      })),
    } as const;
    return postProcessRequirement({ ...base });
  });

  return ensureDualObservableSets(
    SpecIRSchema.parse({
      run_goal: "Verify implementation against provided markdown spec.",
      requirements,
    }),
  );
}

function hasTimePresentObservable(r: {
  expected_observables?: ObservableExpectationIR[];
}): boolean {
  return (r.expected_observables ?? []).some((o) => o.kind === "time_present");
}

function hasButtonAppearanceObservable(r: {
  expected_observables?: ObservableExpectationIR[];
}): boolean {
  return (r.expected_observables ?? []).some((o) => {
    if (o.kind !== "element_visible" || !o.selector) return false;
    if (!/\bbutton\b/i.test(o.selector)) return false;
    const meta = o.metadata;
    if (!meta || typeof meta !== "object" || !("css" in meta)) return false;
    const css = (meta as { css?: unknown }).css;
    if (!css || typeof css !== "object") return false;
    const c = css as Record<string, unknown>;
    return typeof c.backgroundColor === "string" || typeof c.color === "string";
  });
}

function postProcessRequirement(r: {
  id: string;
  source_text: string;
  type: string;
  priority: string;
  expected_observables?: ObservableExpectationIR[];
  notes?: string | undefined;
}) {
  // Only repair clearly-wrong encodings. When the LLM already emitted valid IR, leave it alone.
  if (/\bcurrent time of day\b/i.test(r.source_text)) {
    if (r.type === "visible_state" && hasTimePresentObservable(r)) return r;
    r.type = "visible_state";
    r.expected_observables = [{ kind: "time_present" }];
    r.notes =
      r.notes ??
      "Interpreted as presence of a time-like string in visible UI (not a literal phrase match).";
    return r;
  }

  // Deterministic safety net: style/color statements should not degrade into text_present.
  if (
    /\bbuttons?\b/i.test(r.source_text) &&
    /\b(green|red|blue|purple|orange|yellow|black|white)\b/i.test(r.source_text)
  ) {
    if (r.type === "appearance" && hasButtonAppearanceObservable(r)) return r;
    const color =
      r.source_text.match(
        /\b(green|red|blue|purple|orange|yellow|black|white)\b/i,
      )?.[1] ?? "green";
    r.type = "appearance";
    r.expected_observables = [
      {
        kind: "element_visible",
        selector: "button",
        // Prefer backgroundColor for "buttons are green" expectations; text color varies.
        metadata: { css: { backgroundColor: color.toLowerCase() } },
      },
    ];
    r.notes =
      r.notes ??
      "Appearance constraint inferred from markdown; deterministic judge may not verify styles yet.";
  }
  return r;
}

export async function normalizeMarkdownToSpecIRWithLlmDetailed(
  markdown: string,
  llm: LlmPolicy,
  opts?: {
    onLlmCall?: (e: {
      provider: "ollama" | "remote";
      host?: string;
      model: string;
      system?: string;
      prompt: string;
      responseText: string;
      durationMs: number;
      promptChars: number;
      responseChars: number;
      truncated: { prompt: boolean; response: boolean };
      phase: "spec_normalization";
    }) => void;
    maxPromptChars?: number;
    maxResponseChars?: number;
  },
): Promise<{ specIr: SpecIR; meta: SpecNormalizationMeta }> {
  const startedAt = performance.now();
  const specChars = markdown.length;
  const maxPromptChars = Math.max(0, opts?.maxPromptChars ?? 20_000);
  const maxResponseChars = Math.max(0, opts?.maxResponseChars ?? 20_000);

  const heuristic = (
    provider: "none" | "ollama" | "remote" | "other",
  ): { specIr: SpecIR; meta: SpecNormalizationMeta } => {
    const specIr = ensureDualObservableSets(
      normalizeMarkdownToSpecIR(markdown),
    );
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    return {
      specIr,
      meta: {
        mode: "heuristic" as const,
        provider,
        durationMs,
        specChars,
        usedFallbackHeuristics: true,
      },
    };
  };

  if (llm.normalizer.provider === "none") {
    return heuristic("none");
  }

  if (markdown.length > 40_000) {
    return heuristic(llm.normalizer.provider === "remote" ? "other" : "ollama");
  }

  const system = normalizationSystem();
  const prompt = buildNormalizationPrompt(markdown.trim());
  const maxZodAttempts = Math.max(1, (llm.normalizer.maxRetries ?? 3) + 1);
  let lastFailure: unknown;

  for (let attempt = 0; attempt < maxZodAttempts; attempt++) {
    const t0 = performance.now();
    let responseText: string;
    let modelUsed: string;
    try {
      const out = await chatJsonForRole(llm, "normalizer", {
        system,
        prompt,
      });
      responseText = out.responseText;
      modelUsed = out.modelUsed;
    } catch (e) {
      if (llm.normalizer.provider === "remote") return heuristic("other");
      lastFailure = e;
      continue;
    }

    const durMs = Math.max(0, Math.round(performance.now() - t0));
    opts?.onLlmCall?.({
      provider: llm.normalizer.provider === "remote" ? "remote" : "ollama",
      ...(llm.normalizer.provider === "remote"
        ? llm.normalizer.remoteBaseUrl?.trim()
          ? { host: llm.normalizer.remoteBaseUrl.trim() }
          : {}
        : { host: llm.ollamaHost }),
      model: modelUsed,
      system,
      prompt:
        prompt.length > maxPromptChars
          ? `${prompt.slice(0, maxPromptChars)}\n…(truncated)`
          : prompt,
      responseText:
        responseText.length > maxResponseChars
          ? `${responseText.slice(0, maxResponseChars)}\n…(truncated)`
          : responseText,
      durationMs: durMs,
      promptChars: prompt.length,
      responseChars: responseText.length,
      truncated: {
        prompt: prompt.length > maxPromptChars,
        response: responseText.length > maxResponseChars,
      },
      phase: "spec_normalization",
    });

    let raw: unknown;
    try {
      raw = JSON.parse(responseText);
    } catch {
      lastFailure = new Error("normalize: non-JSON model output");
      continue;
    }

    try {
      const specIr = finalizeParsedSpecIr(raw);
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      const mode =
        llm.normalizer.provider === "remote"
          ? ("remote" as const)
          : ("ollama" as const);
      return {
        specIr,
        meta:
          mode === "remote"
            ? {
                mode: "remote",
                provider: "remote",
                selectedModel: modelUsed,
                durationMs,
                specChars,
                usedFallbackHeuristics: false,
                ...(attempt > 0 ? { retriedWithFallbackModel: true } : {}),
              }
            : {
                mode: "ollama",
                provider: "ollama",
                selectedModel: modelUsed,
                durationMs,
                specChars,
                usedFallbackHeuristics: false,
                retriedWithFallbackModel: attempt > 0,
              },
      };
    } catch (e) {
      lastFailure = e;
    }
  }

  if (llm.normalizer.provider === "remote") return heuristic("other");
  if (lastFailure) throw lastFailure;
  return heuristic("ollama");
}

export async function normalizeMarkdownToSpecIRWithLlm(
  markdown: string,
  llm: LlmPolicy,
): Promise<SpecIR> {
  const out = await normalizeMarkdownToSpecIRWithLlmDetailed(markdown, llm);
  return out.specIr;
}
