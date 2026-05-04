import {
  loadProjectConfig,
  mergeLlmPolicyWithNamedProfile,
} from "../config/projectConfig.js";
import {
  checkOllamaRunning,
  ensureOllamaModelForPolicy,
  listLocalModels,
  pullModel,
  suggestModels,
} from "../llm/modelOps.js";
import {
  bytesToGiB,
  getHostTotalMemoryBytes,
  ramTierRationale,
  suggestMaxApproxQ4ModelRamGiB,
  suggestProfileKeyFromTotalRamGiB,
} from "../llm/ramTier.js";
import {
  LlmPolicySchema,
  type LlmPolicy,
  type RecommendedModel,
} from "../llm/types.js";
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

export type LlmHardwareHint = {
  totalMemBytes: number;
  totalMemGiB: number;
  suggestedProfileKey: string;
  profileExistsInProject: boolean;
  rationale: string;
  maxApproxQ4RamGiBForCatalog: number;
  recommendedForRam: RecommendedModel[];
  /** Policy after merging the suggested profile when it exists in `profiles`; otherwise base project `llm` / defaults. */
  previewLlmPolicy: LlmPolicy;
};

export function buildLlmHardwareHint(opts?: {
  projectRootDir?: string;
}): LlmHardwareHint {
  const bytes = getHostTotalMemoryBytes();
  const totalGiB = bytesToGiB(bytes);
  const suggestedProfileKey = suggestProfileKeyFromTotalRamGiB(totalGiB);
  const { config: project } = loadProjectConfig(
    opts?.projectRootDir !== undefined
      ? { rootDir: opts.projectRootDir }
      : {},
  );
  const profileExists = Boolean(project?.profiles?.[suggestedProfileKey]);
  const base = LlmPolicySchema.parse(project?.llm ?? {});
  const previewLlmPolicy = mergeLlmPolicyWithNamedProfile(
    base,
    project,
    profileExists ? suggestedProfileKey : null,
  );
  const maxApprox = suggestMaxApproxQ4ModelRamGiB(totalGiB);
  const recommendedForRam = suggestModels({
    needTooling: true,
    maxApproxQ4RamGiB: maxApprox,
  });
  return {
    totalMemBytes: bytes,
    totalMemGiB: Math.round(totalGiB * 10) / 10,
    suggestedProfileKey,
    profileExistsInProject: profileExists,
    rationale: ramTierRationale(totalGiB, suggestedProfileKey),
    maxApproxQ4RamGiBForCatalog: maxApprox,
    recommendedForRam,
    previewLlmPolicy,
  };
}

export function modelSuggest(
  _ctx: OpsContext,
  input?: { requireTooling?: boolean },
) {
  const needTooling = input?.requireTooling ?? true;
  const recs = suggestModels({ needTooling });
  const hardware = buildLlmHardwareHint();
  const recsRam = suggestModels({
    needTooling,
    maxApproxQ4RamGiB: hardware.maxApproxQ4RamGiBForCatalog,
  });
  return {
    models: recs.map((r) => ({ name: r.name, notes: r.notes })),
    modelsMatchingRam: recsRam.map((r) => ({
      name: r.name,
      notes: r.notes,
      approxQ4RamGiB: r.approxQ4RamGiB,
    })),
    hardware: {
      totalMemGiB: hardware.totalMemGiB,
      totalMemBytes: hardware.totalMemBytes,
      suggestedProfileKey: hardware.suggestedProfileKey,
      profileExistsInProject: hardware.profileExistsInProject,
      rationale: hardware.rationale,
      maxApproxQ4RamGiBForCatalog: hardware.maxApproxQ4RamGiBForCatalog,
    },
  };
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
  const policy = input?.llm ?? LlmPolicySchema.parse({});
  return await ensureOllamaModelForPolicy(policy, policy.judge.model);
}

export async function modelCatalog(
  _ctx: OpsContext,
  input?: { host?: string; requireTooling?: boolean },
): Promise<{
  ollama: Awaited<ReturnType<typeof checkOllamaRunning>>;
  installed: Array<{ name: string; size?: number; modifiedAt?: string }>;
  recommended: RecommendedModel[];
  hardware: LlmHardwareHint;
}> {
  const host = input?.host ?? "http://127.0.0.1:11434";
  const ollama = await checkOllamaRunning(host);
  const installed = ollama.ok ? await listLocalModels(host) : [];
  const needTooling = input?.requireTooling ?? true;
  const hardware = buildLlmHardwareHint();
  const recommended = suggestModels({
    needTooling,
    maxApproxQ4RamGiB: hardware.maxApproxQ4RamGiBForCatalog,
  });
  return {
    ollama,
    installed: installed.map((m) => ({
      name: m.name,
      ...(typeof m.size === "number" ? { size: m.size } : {}),
      ...(typeof m.modifiedAt === "string" ? { modifiedAt: m.modifiedAt } : {}),
    })),
    recommended,
    hardware,
  };
}
