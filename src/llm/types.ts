import { z } from "zod";

/** Per-role LLM provider (each phase can use Ollama, remote API, or be disabled). */
export const LlmRoleProviderSchema = z.enum(["ollama", "remote", "none"]);
export type LlmRoleProvider = z.infer<typeof LlmRoleProviderSchema>;

export const LlmRoleConfigSchema = z.object({
  provider: LlmRoleProviderSchema.default("ollama"),
  model: z.string().min(1),
  fallbackModel: z.string().optional(),
  temperature: z.number().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  remoteBaseUrl: z.string().optional(),
  remoteApiKey: z.string().optional(),
  /**
   * Ollama only: when `true`, judge calls use `format: "json"`. When `false`, JSON is parsed
   * from the tail so reasoning models can emit thinking first. Omitted → heuristic from `model`
   * (off for e.g. DeepSeek-R1 / QwQ, on for instruct models).
   */
  ollamaJsonFormat: z.boolean().optional(),
});
export type LlmRoleConfig = z.infer<typeof LlmRoleConfigSchema>;

export const LlmRoleSchema = z.enum([
  "normalizer",
  "plannerAssist",
  "judge",
  "triage",
]);
export type LlmRole = z.infer<typeof LlmRoleSchema>;

const defaultNormalizer: LlmRoleConfig = {
  provider: "ollama",
  model: "qwen2.5:14b-instruct",
  fallbackModel: "qwen2.5:7b-instruct",
  temperature: 0.1,
  maxRetries: 3,
};

const defaultPlannerAssist: LlmRoleConfig = {
  provider: "ollama",
  model: "qwen2.5:14b-instruct",
  temperature: 0.2,
};

const defaultJudge: LlmRoleConfig = {
  provider: "ollama",
  model: "deepseek-r1:14b",
  fallbackModel: "qwen2.5:14b-instruct",
  temperature: 0,
  maxRetries: 2,
};

const defaultTriage: LlmRoleConfig = {
  provider: "ollama",
  model: "deepseek-r1:14b",
  temperature: 0.1,
};

export const LlmPolicySchema = z.object({
  ollamaHost: z.string().default("http://127.0.0.1:11434"),
  allowAutoPull: z.boolean().default(true),
  requireToolCapable: z.boolean().default(true),
  normalizer: LlmRoleConfigSchema.default(() => ({ ...defaultNormalizer })),
  plannerAssist: LlmRoleConfigSchema.default(() => ({
    ...defaultPlannerAssist,
  })),
  judge: LlmRoleConfigSchema.default(() => ({ ...defaultJudge })),
  triage: LlmRoleConfigSchema.default(() => ({ ...defaultTriage })),
});

export type LlmPolicy = z.infer<typeof LlmPolicySchema>;

export function summarizeLlmPolicyForRun(llm?: LlmPolicy): {
  llm_provider: string | null;
  llm_model: string | null;
} {
  if (!llm) return { llm_provider: null, llm_model: null };
  const provs = new Set<LlmRoleProvider>([
    llm.normalizer.provider,
    llm.plannerAssist.provider,
    llm.judge.provider,
    llm.triage.provider,
  ]);
  provs.delete("none");
  let llm_provider: string | null = null;
  if (provs.size === 0) llm_provider = "none";
  else if (provs.size === 1) llm_provider = [...provs][0] ?? null;
  else llm_provider = provs.has("remote") ? "mixed_remote" : "mixed";

  const llm_model = [
    `n:${llm.normalizer.model}`,
    `p:${llm.plannerAssist.model}`,
    `j:${llm.judge.model}`,
    `t:${llm.triage.model}`,
  ].join("|");

  return { llm_provider, llm_model };
}

export function policyUsesOllama(llm: LlmPolicy): boolean {
  return (
    llm.normalizer.provider === "ollama" ||
    llm.plannerAssist.provider === "ollama" ||
    llm.judge.provider === "ollama" ||
    llm.triage.provider === "ollama"
  );
}

export function policyJudgeOrPlannerActive(llm: LlmPolicy): boolean {
  return llm.judge.provider !== "none" || llm.plannerAssist.provider !== "none";
}

/** Ollama model tags to unload after a run (deduped). */
export function ollamaModelsFromPolicy(llm: LlmPolicy): string[] {
  const out = new Set<string>();
  const add = (c: LlmRoleConfig) => {
    if (c.provider !== "ollama") return;
    if (c.model.trim()) out.add(c.model.trim());
    if (c.fallbackModel?.trim()) out.add(c.fallbackModel.trim());
  };
  add(llm.normalizer);
  add(llm.plannerAssist);
  add(llm.judge);
  add(llm.triage);
  return [...out];
}

export type ModelCapability = {
  supportsJsonWell: boolean;
  minContextTokensHint?: number;
  speedTier?: "fast" | "balanced" | "slow";
};

export type RecommendedModel = {
  name: string;
  provider: "ollama";
  capability: ModelCapability;
  /** Approximate Q4 VRAM/RAM footprint (GiB), for host RAM-aware filtering. */
  approxQ4RamGiB?: number;
  notes?: string;
};
