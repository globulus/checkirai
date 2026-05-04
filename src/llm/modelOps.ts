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
  /** When set, drop models whose `approxQ4RamGiB` exceeds this (undefined `approxQ4RamGiB` is kept). */
  maxApproxQ4RamGiB?: number;
}): RecommendedModel[] {
  const needTooling = opts?.needTooling ?? true;
  const minContext = opts?.minContext;
  const maxRam = opts?.maxApproxQ4RamGiB;

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
  if (typeof maxRam === "number" && Number.isFinite(maxRam)) {
    models = models.filter(
      (m) => m.approxQ4RamGiB == null || m.approxQ4RamGiB <= maxRam,
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

/**
 * Ensure a specific Ollama model tag exists locally (pull if allowed).
 * Used for per-role `model` strings (no global "auto" selection).
 */
export async function ensureOllamaModelForPolicy(
  policy: LlmPolicy,
  modelName: string,
): Promise<{ selectedModel: string; pulled: boolean }> {
  const desired = modelName.trim();
  if (!desired) {
    throw new VerifierError("CONFIG_ERROR", "Ollama model name is empty.", {
      details: { host: policy.ollamaHost },
    });
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

  if (localNames.has(desired)) return { selectedModel: desired, pulled: false };
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
