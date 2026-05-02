import { z } from "zod";

export const LlmProviderSchema = z.enum(["ollama", "remote", "none"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const LlmPolicySchema = z.object({
  provider: LlmProviderSchema.default("ollama"),
  allowAutoPull: z.boolean().default(true),
  requireToolCapable: z.boolean().default(true),
  ollamaHost: z.string().default("http://127.0.0.1:11434"),
  ollamaModel: z.string().default("auto"),
  remoteBaseUrl: z.string().optional(),
  remoteApiKey: z.string().optional(),
});
export type LlmPolicy = z.infer<typeof LlmPolicySchema>;

export type ModelCapability = {
  /** Model is expected to reliably output JSON adhering to schemas. */
  supportsJsonWell: boolean;
  /** Rough guidance; used for recommendation only. */
  minContextTokensHint?: number;
  speedTier?: "fast" | "balanced" | "slow";
};

export type RecommendedModel = {
  name: string;
  provider: "ollama";
  capability: ModelCapability;
  notes?: string;
};
