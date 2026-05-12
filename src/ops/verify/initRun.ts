import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pruneArtifactRuns } from "../../artifacts/prune.js";
import {
  loadProjectConfig,
  mergeLlmPolicyWithProjectProfile,
} from "../../config/projectConfig.js";
import { LlmPolicySchema, summarizeLlmPolicyForRun } from "../../llm/types.js";
import {
  getRun,
  insertRunIfMissing,
  updateRunLineage,
} from "../../persistence/repo/runRepo.js";
import type { OpsContext } from "../context.js";
import type { RunEvent, RunEventSink } from "../events.js";
import { createRunAbortSignal } from "../runAbortSignal.js";
import { ensureDir, nowIso } from "./artifacts.js";
import type { VerifyRunContext } from "./context.js";
import {
  RestartFromPhaseSchema,
  type RestartFromPhase,
  type VerifySpecInput,
} from "./types.js";

export function initVerifyRun(
  ctx: OpsContext,
  input: VerifySpecInput,
  opts?: { onEvent?: RunEventSink; runId?: string; signal?: AbortSignal },
): VerifyRunContext {
  const outRoot = input.outDir ?? ctx.outRoot;
  const runsDir = join(outRoot, "runs");
  const artifactsDir = join(outRoot, "artifacts");
  ensureDir(runsDir);
  ensureDir(artifactsDir);

  const projectCfg = loadProjectConfig().config;
  const def = projectCfg?.defaults;
  const maxRunMs = input.maxRunMs ?? def?.maxRunMs;
  const runCommandAllowlist =
    input.runCommandAllowlist ?? def?.runCommandAllowlist;
  const stepRetries = input.stepRetries ?? def?.stepRetries;
  const stepRetryDelayMs = input.stepRetryDelayMs ?? def?.stepRetryDelayMs;
  const isolateProbeSessions =
    input.isolateProbeSessions ?? def?.isolateProbeSessions;
  const artifactMaxRuns = input.artifactMaxRuns ?? def?.artifactMaxRuns;
  const allowShellMetacharacters = def?.allowShellMetacharacters === true;
  if (typeof artifactMaxRuns === "number" && artifactMaxRuns > 0) {
    pruneArtifactRuns(artifactsDir, artifactMaxRuns);
  }

  const llmPolicy = mergeLlmPolicyWithProjectProfile(
    LlmPolicySchema.parse(input.llm ?? projectCfg?.llm ?? {}),
    projectCfg ?? undefined,
  );
  const llmRunRow = summarizeLlmPolicyForRun(llmPolicy);
  const requestedPolicy = input.policyName ?? "read_only";

  const restartFromPhase = RestartFromPhaseSchema.parse(
    input.restartFromPhase ?? "start",
  );
  const parentRunId =
    typeof input.restartFromRunId === "string" && input.restartFromRunId.trim()
      ? input.restartFromRunId.trim()
      : undefined;

  if (restartFromPhase !== "start" && !parentRunId) {
    throw new Error(
      `restartFromPhase=${restartFromPhase} requires restartFromRunId (parent run id).`,
    );
  }
  if (restartFromPhase !== "start" && parentRunId) {
    const parent = getRun(ctx.db, parentRunId);
    if (!parent) throw new Error(`Unknown parent runId: ${parentRunId}`);
  }

  const runId = opts?.runId ?? randomUUID();
  const createdAt = nowIso();
  const start = performance.now();

  const lineageParent: string | null =
    restartFromPhase !== "start" && parentRunId ? parentRunId : null;
  const lineagePhase: RestartFromPhase | null =
    restartFromPhase !== "start" ? restartFromPhase : null;

  insertRunIfMissing(ctx.db, {
    id: runId,
    created_at: createdAt,
    target_base_url: input.targetUrl,
    policy_name: null,
    llm_provider: llmRunRow.llm_provider,
    llm_model: llmRunRow.llm_model,
    status: "running",
    confidence: null,
    summary_md_path: null,
    report_json_path: null,
    parent_run_id: lineageParent,
    restart_from_phase: lineagePhase,
  });
  if (lineageParent) {
    updateRunLineage(ctx.db, runId, {
      parent_run_id: lineageParent,
      restart_from_phase: lineagePhase,
    });
  }

  const publish = (e: RunEvent) => {
    ctx.events.publish(e);
    opts?.onEvent?.(e);
  };

  publish({
    type: "run_queued",
    runId,
    createdAt,
    meta: {
      targetUrl: input.targetUrl,
      ...(lineageParent
        ? { parentRunId: lineageParent, restartFromPhase }
        : {}),
    },
  });

  const ollamaModelsUsed = new Set<string>();
  const recordModel = (m: string) => {
    if (typeof m === "string" && m.trim()) ollamaModelsUsed.add(m.trim());
  };

  const { signal: runAbortSignal, dispose: disposeRunAbort } =
    createRunAbortSignal({
      ...(typeof maxRunMs === "number" && maxRunMs > 0 ? { maxRunMs } : {}),
      ...(opts?.signal ? { userSignal: opts.signal } : {}),
    });

  return {
    ctx,
    input,
    opts,
    outRoot,
    runsDir,
    artifactsDir,
    projectCfg,
    maxRunMs,
    runCommandAllowlist,
    stepRetries,
    stepRetryDelayMs,
    isolateProbeSessions,
    allowShellMetacharacters,
    llmPolicy,
    requestedPolicy,
    restartFromPhase,
    parentRunId,
    runId,
    createdAt,
    start,
    lineageParent,
    lineagePhase,
    publish,
    recordModel,
    ollamaModelsUsed,
    launchChild: {},
    runAbortSignal,
    disposeRunAbort,
    dartProjectRoot: undefined,
    specIr: undefined,
  };
}
