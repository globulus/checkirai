import type { LlmRoleConfig } from "./types.js";

/** Heuristic: models that usually emit thinking before JSON (avoid Ollama `format: "json"`). */
export function isLikelyThinkingOllamaModel(modelName: string): boolean {
  const m = modelName.toLowerCase().trim();
  if (!m) return false;
  if (m.includes("qwq")) return true;
  if (m.includes("deepseek-r1") || m.includes("deepseek_r1")) return true;
  // e.g. `...-r1:14b`, `.../r1:latest`
  if (/(^|[/:_-])r1([/:_.-]|$)/i.test(m)) return true;
  return false;
}

/**
 * When `true`, Ollama judge calls use `format: "json"` (strict JSON only).
 * When `false`, the model may emit reasoning/thinking before the JSON object.
 *
 * Config: `llm.judge.ollamaJsonFormat` — explicit boolean overrides the heuristic.
 * If omitted, thinking-style model ids default to `false`, others to `true`.
 */
export function effectiveOllamaJsonFormatForJudge(
  judge: LlmRoleConfig,
): boolean {
  if (judge.provider !== "ollama") return true;
  if (typeof judge.ollamaJsonFormat === "boolean")
    return judge.ollamaJsonFormat;
  return !isLikelyThinkingOllamaModel(judge.model);
}
