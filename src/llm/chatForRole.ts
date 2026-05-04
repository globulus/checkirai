import { ollamaGenerate } from "./ollamaHttp.js";
import { remoteChatCompletion } from "./remoteOpenAIClient.js";
import { ensureOllamaModelForPolicy } from "./modelOps.js";
import type { LlmPolicy, LlmRole, LlmRoleConfig } from "./types.js";
import { VerifierError } from "../shared/errors.js";

function roleConfig(policy: LlmPolicy, role: LlmRole): LlmRoleConfig {
  return policy[role];
}

/**
 * Returns the role config used for **test planning** LLM calls: plannerAssist when enabled,
 * otherwise judge (so a judge-only policy can still produce plans).
 */
export function effectivePlannerRoleConfig(policy: LlmPolicy): LlmRoleConfig {
  if (policy.plannerAssist.provider !== "none") return policy.plannerAssist;
  return policy.judge;
}

/** Policy view where `plannerAssist` is the config used for planning LLM calls (falls back to judge). */
export function policyForPlannerLlmCall(policy: LlmPolicy): LlmPolicy {
  if (policy.plannerAssist.provider !== "none") return policy;
  return { ...policy, plannerAssist: { ...policy.judge } };
}

export async function chatJsonForRole(
  policy: LlmPolicy,
  role: LlmRole,
  input: { system: string; prompt: string },
  hooks?: {
    onSelectedModel?: (model: string) => void;
    /** When set, overrides role config `temperature` for this call only. */
    temperatureOverride?: number;
    /**
     * When `false`, Ollama omits `format: "json"` so reasoning models can emit
     * thinking before the JSON verdict; callers must parse JSON from the tail.
     * @default true
     */
    ollamaUseJsonFormat?: boolean;
  },
): Promise<{ responseText: string; modelUsed: string }> {
  const cfg = roleConfig(policy, role);
  const temp = hooks?.temperatureOverride ?? cfg.temperature ?? 0;
  if (cfg.provider === "none") {
    throw new VerifierError(
      "CONFIG_ERROR",
      `LLM role "${role}" is disabled (provider none).`,
    );
  }

  if (cfg.provider === "remote") {
    const baseUrl = cfg.remoteBaseUrl?.trim();
    const apiKey = cfg.remoteApiKey?.trim();
    if (!baseUrl || !apiKey) {
      throw new VerifierError(
        "CONFIG_ERROR",
        `Role "${role}": remote provider requires remoteBaseUrl and remoteApiKey.`,
      );
    }
    const model = cfg.model.trim() || "gpt-4o-mini";
    const out = await remoteChatCompletion({
      baseUrl,
      apiKey,
      model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      temperature: temp,
    });
    hooks?.onSelectedModel?.(model);
    return { responseText: out.content, modelUsed: model };
  }

  const tryModel = async (modelName: string) => {
    const { selectedModel } = await ensureOllamaModelForPolicy(
      policy,
      modelName,
    );
    hooks?.onSelectedModel?.(selectedModel);
    return await ollamaGenerate(policy.ollamaHost, {
      model: selectedModel,
      system: input.system,
      prompt: input.prompt,
      ...(hooks?.ollamaUseJsonFormat === false ? {} : { format: "json" as const }),
      stream: false,
      options: { temperature: temp },
    });
  };

  try {
    const gen = await tryModel(cfg.model);
    return { responseText: gen.response, modelUsed: gen.model };
  } catch (err) {
    const fb = cfg.fallbackModel?.trim();
    if (
      fb &&
      fb !== cfg.model.trim() &&
      err instanceof VerifierError &&
      err.code === "LLM_PROVIDER_ERROR" &&
      (err.details?.status === 500 || err.details?.status === "500")
    ) {
      const gen = await tryModel(fb);
      return { responseText: gen.response, modelUsed: gen.model };
    }
    throw err;
  }
}

/** Text completion (no JSON format hint) for triage / prose. */
export async function chatTextForRole(
  policy: LlmPolicy,
  role: LlmRole,
  input: { system: string; prompt: string },
  hooks?: { onSelectedModel?: (model: string) => void },
): Promise<{ responseText: string; modelUsed: string }> {
  const cfg = roleConfig(policy, role);
  if (cfg.provider === "none") {
    throw new VerifierError(
      "CONFIG_ERROR",
      `LLM role "${role}" is disabled (provider none).`,
    );
  }

  if (cfg.provider === "remote") {
    const baseUrl = cfg.remoteBaseUrl?.trim();
    const apiKey = cfg.remoteApiKey?.trim();
    if (!baseUrl || !apiKey) {
      throw new VerifierError(
        "CONFIG_ERROR",
        `Role "${role}": remote provider requires remoteBaseUrl and remoteApiKey.`,
      );
    }
    const model = cfg.model.trim() || "gpt-4o-mini";
    const out = await remoteChatCompletion({
      baseUrl,
      apiKey,
      model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      temperature: cfg.temperature ?? 0.1,
    });
    hooks?.onSelectedModel?.(model);
    return { responseText: out.content, modelUsed: model };
  }

  const temp = cfg.temperature ?? 0.1;
  const { selectedModel } = await ensureOllamaModelForPolicy(policy, cfg.model);
  hooks?.onSelectedModel?.(selectedModel);
  const gen = await ollamaGenerate(policy.ollamaHost, {
    model: selectedModel,
    system: input.system,
    prompt: input.prompt,
    stream: false,
    options: { temperature: temp },
  });
  return { responseText: gen.response, modelUsed: gen.model };
}
