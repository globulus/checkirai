import { VerifierError } from "../shared/errors.js";
import {
  ollamaGetVersion,
  ollamaListTags,
  ollamaPullModelStream,
} from "./ollamaHttp.js";
import { RECOMMENDED_OLLAMA_MODELS } from "./recommendedModels.js";
import type { LlmPolicy, RecommendedModel } from "./types.js";

export type OllamaStatus = {
  ok: boolean;
  host: string;
  version?: string;
  error?: { code: string; message: string };
};

export type LocalModel = {
  name: string;
  digest?: string;
  size?: number;
  modifiedAt?: string;
};

export async function checkOllamaRunning(host: string): Promise<OllamaStatus> {
  try {
    const { version } = await ollamaGetVersion(host);
    return { ok: true, host, version };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const code = err instanceof VerifierError ? err.code : "OLLAMA_NOT_RUNNING";
    return { ok: false, host, error: { code, message } };
  }
}

export async function listLocalModels(host: string): Promise<LocalModel[]> {
  const tags = await ollamaListTags(host);
  return tags.models.map((m) => ({
    name: m.name || m.model,
    digest: m.digest,
    size: m.size,
    modifiedAt: m.modified_at,
  }));
}

export function suggestModels(opts?: {
  needTooling?: boolean;
  minContext?: number;
}): RecommendedModel[] {
  const needTooling = opts?.needTooling ?? true;
  const minContext = opts?.minContext;

  // MVP: curated list only. If `needTooling`, filter out models we don't trust for structured output.
  let models = RECOMMENDED_OLLAMA_MODELS.slice();
  if (needTooling) {
    models = models.filter((m) => m.capability.supportsJsonWell);
  }
  if (minContext) {
    models = models.filter(
      (m) => (m.capability.minContextTokensHint ?? 0) >= minContext,
    );
  }
  return models;
}

export async function pullModel(
  host: string,
  modelName: string,
  onProgress?: (p: {
    status: string;
    completed?: number;
    total?: number;
  }) => void,
): Promise<void> {
  for await (const p of ollamaPullModelStream(host, modelName)) {
    if ("total" in p && "completed" in p) {
      onProgress?.({
        status: p.status,
        completed: p.completed,
        total: p.total,
      });
    } else {
      onProgress?.({ status: p.status });
    }
  }
}

export async function ensureModelAvailable(
  policy: LlmPolicy,
): Promise<{ selectedModel: string; pulled: boolean }> {
  if (policy.provider !== "ollama") {
    throw new VerifierError(
      "CONFIG_ERROR",
      "ensureModelAvailable only applies to provider=ollama.",
    );
  }

  const status = await checkOllamaRunning(policy.ollamaHost);
  if (!status.ok) {
    throw new VerifierError(
      "OLLAMA_NOT_RUNNING",
      status.error?.message ?? "Ollama is not running.",
      {
        details: { host: policy.ollamaHost },
      },
    );
  }

  const local = await listLocalModels(policy.ollamaHost);
  const localNames = new Set(local.map((m) => m.name));

  const desired = policy.ollamaModel;
  if (desired !== "auto") {
    if (localNames.has(desired))
      return { selectedModel: desired, pulled: false };
    if (!policy.allowAutoPull) {
      throw new VerifierError(
        "OLLAMA_MODEL_MISSING",
        `Ollama model not installed: ${desired}`,
        {
          details: { host: policy.ollamaHost, model: desired },
        },
      );
    }
    await pullModel(policy.ollamaHost, desired);
    return { selectedModel: desired, pulled: true };
  }

  // auto-selection: prefer installed recommended models; else pull top recommendation if allowed.
  const recommended = suggestModels({ needTooling: policy.requireToolCapable });
  const installedRecommended = recommended.find((m) => localNames.has(m.name));
  if (installedRecommended) {
    // Prefer lighter/faster installed models to reduce risk of OOM/slow startups.
    const tierRank: Record<"fast" | "balanced" | "slow", number> = {
      fast: 3,
      balanced: 2,
      slow: 1,
    };
    const best = recommended
      .filter((m) => localNames.has(m.name))
      .slice()
      .sort((a: RecommendedModel, b: RecommendedModel) => {
        const ar = a.capability.speedTier ? tierRank[a.capability.speedTier] : 0;
        const br = b.capability.speedTier ? tierRank[b.capability.speedTier] : 0;
        // Higher rank first; break ties by higher context hint (if any).
        const ctxA = a.capability.minContextTokensHint ?? 0;
        const ctxB = b.capability.minContextTokensHint ?? 0;
        if (br !== ar) return br - ar;
        return ctxB - ctxA;
      })[0];
    if (best) return { selectedModel: best.name, pulled: false };
    return { selectedModel: installedRecommended.name, pulled: false };
  }

  const top = recommended[0];
  if (!top) {
    throw new VerifierError(
      "CONFIG_ERROR",
      "No recommended Ollama models configured.",
    );
  }
  if (!policy.allowAutoPull) {
    throw new VerifierError(
      "OLLAMA_MODEL_MISSING",
      `No recommended Ollama model installed. Suggested: ${top.name}`,
      { details: { host: policy.ollamaHost, suggested: top.name } },
    );
  }
  await pullModel(policy.ollamaHost, top.name);
  return { selectedModel: top.name, pulled: true };
}
