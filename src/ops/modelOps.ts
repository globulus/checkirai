import {
  checkOllamaRunning,
  ensureModelAvailable,
  listLocalModels,
  pullModel,
  suggestModels,
} from "../llm/modelOps.js";
import type { LlmPolicy, RecommendedModel } from "../llm/types.js";
import type { OpsContext } from "./context.js";

export async function ollamaStatus(
  _ctx: OpsContext,
  input?: { host?: string },
) {
  return await checkOllamaRunning(input?.host ?? "http://127.0.0.1:11434");
}

export async function modelList(_ctx: OpsContext, input?: { host?: string }) {
  const models = await listLocalModels(input?.host ?? "http://127.0.0.1:11434");
  return { models: models.map((m) => ({ name: m.name, size: m.size })) };
}

export function modelSuggest(
  _ctx: OpsContext,
  input?: { requireTooling?: boolean },
) {
  const recs = suggestModels({ needTooling: input?.requireTooling ?? true });
  return { models: recs.map((r) => ({ name: r.name, notes: r.notes })) };
}

export async function modelPull(
  _ctx: OpsContext,
  input: { host?: string; modelName: string },
) {
  await pullModel(input.host ?? "http://127.0.0.1:11434", input.modelName);
  return { ok: true, modelName: input.modelName };
}

export async function modelEnsure(
  _ctx: OpsContext,
  input?: { llm?: LlmPolicy },
) {
  const policy = input?.llm ?? ({ provider: "ollama" } as LlmPolicy);
  const out = await ensureModelAvailable(policy);
  return out;
}

export async function modelCatalog(
  _ctx: OpsContext,
  input?: { host?: string; requireTooling?: boolean },
): Promise<{
  ollama: Awaited<ReturnType<typeof checkOllamaRunning>>;
  installed: Array<{ name: string; size?: number; modifiedAt?: string }>;
  recommended: RecommendedModel[];
}> {
  const host = input?.host ?? "http://127.0.0.1:11434";
  const ollama = await checkOllamaRunning(host);
  const installed = ollama.ok ? await listLocalModels(host) : [];
  const recommended = suggestModels({
    needTooling: input?.requireTooling ?? true,
  });
  return {
    ollama,
    installed: installed.map((m) => ({
      name: m.name,
      ...(typeof m.size === "number" ? { size: m.size } : {}),
      ...(typeof m.modifiedAt === "string" ? { modifiedAt: m.modifiedAt } : {}),
    })),
    recommended,
  };
}
