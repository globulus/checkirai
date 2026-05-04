import type { RecommendedModel } from "./types.js";

/**
 * Curated shortlist of models that tend to work well for structured outputs
 * (planning probes, JSON diffs, repair hints) under Ollama.
 *
 * `approxQ4RamGiB` follows the order-of-magnitude table in
 * `checkirai_llm_implementation_plan.md` (Q4 footprint, not exact).
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
    approxQ4RamGiB: 12,
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
    approxQ4RamGiB: 5,
    notes: "Fast normalization fallback; weaker on complex JSON.",
  },
  {
    name: "llama3.1:8b-instruct",
    provider: "ollama",
    capability: {
      supportsJsonWell: true,
      minContextTokensHint: 8192,
      speedTier: "balanced",
    },
    approxQ4RamGiB: 6,
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
    approxQ4RamGiB: 9,
    notes: "Higher quality normalization / planner assist; heavier.",
  },
  {
    name: "deepseek-r1:14b",
    provider: "ollama",
    capability: {
      supportsJsonWell: true,
      minContextTokensHint: 8192,
      speedTier: "slow",
    },
    approxQ4RamGiB: 16,
    notes: "Chain-of-thought; strong judge/triage (needs ~16 GiB model RAM).",
  },
  {
    name: "qwen2.5:32b-instruct",
    provider: "ollama",
    capability: {
      supportsJsonWell: true,
      minContextTokensHint: 8192,
      speedTier: "slow",
    },
    approxQ4RamGiB: 20,
    notes: "High-accuracy judgment when RAM allows (24 GiB+ class machines).",
  },
];
