import type { RecommendedModel } from "./types.js";

/**
 * Curated shortlist of models that tend to work well for structured outputs
 * (planning probes, JSON diffs, repair hints) under Ollama.
 *
 * This is intentionally small for MVP; it can expand over time or become configurable.
 */
export const RECOMMENDED_OLLAMA_MODELS: RecommendedModel[] = [
  {
    name: "qwen3.6:latest",
    provider: "ollama",
    capability: {
      supportsJsonWell: true,
      minContextTokensHint: 8192,
      speedTier: "balanced",
    },
    notes: "Strong structured output; preferred default if available.",
  },
  {
    name: "qwen2.5:7b-instruct",
    provider: "ollama",
    capability: {
      supportsJsonWell: true,
      minContextTokensHint: 8192,
      speedTier: "balanced",
    },
    notes: "Older but reliable structured output fallback.",
  },
  {
    name: "llama3.1:8b-instruct",
    provider: "ollama",
    capability: {
      supportsJsonWell: true,
      minContextTokensHint: 8192,
      speedTier: "balanced",
    },
    notes: "Solid general-purpose instruction model.",
  },
  {
    name: "qwen2.5:14b-instruct",
    provider: "ollama",
    capability: {
      supportsJsonWell: true,
      minContextTokensHint: 8192,
      speedTier: "slow",
    },
    notes: "Higher quality; slower/heavier.",
  },
];
