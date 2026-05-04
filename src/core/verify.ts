import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pruneArtifactRuns } from "../artifacts/prune.js";
import { ArtifactStore } from "../artifacts/store.js";
import type { CapabilitySet } from "../capabilities/types.js";
import { judgeDeterministic } from "../evaluators/judge.js";
import { runTriageMarkdown } from "../evaluators/triageRun.js";
import { executePlan } from "../executors/engine.js";
import type { ExecutorIntegrations } from "../executors/integrations.js";
import { summarizeLlmPolicyForRun, type LlmPolicy } from "../llm/types.js";
import { migrate, openDb } from "../persistence/db.js";
import { insertArtifact } from "../persistence/repo/artifactRepo.js";
import {
  insertRequirements,
  updateRequirementResult,
} from "../persistence/repo/requirementRepo.js";
import { insertRun, updateRunStatus } from "../persistence/repo/runRepo.js";
import { planProbes } from "../planners/planner.js";
import { VerifierError } from "../shared/errors.js";
import type { SpecIR } from "../spec/ir.js";
import { type VerificationResult, VerificationResultSchema } from "./result.js";
import { synthesizeResult } from "./synthesize.js";

export type VerifyTarget = {
  baseUrl: string;
};

export type VerifyConstraints = {
  policyName?: "read_only" | "ui_only";
  llm?: LlmPolicy;
  outDir?: string;
  /** When set > 0, aborts the run if wall-clock time exceeds this budget (cooperative checks between probes/steps). */
  maxRunMs?: number;
  /**
   * Prefix (`foo*`) or full command-line allowlist for `run_command`.
   * Empty / omitted means no shell commands run (even if the capability is enabled).
   */
  runCommandAllowlist?: string[];
  stepRetries?: number;
  stepRetryDelayMs?: number;
  /** When true, each requirement probe is planned in its own session (sequential; fresh bootstrap navigate each session). */
  isolateProbeSessions?: boolean;
  /** Keep only the N most recent run artifact directories under the artifacts root. Omit to skip pruning. */
  artifactMaxRuns?: number;
  /**
   * When set to the same URL as `target.baseUrl`, enables spec-echo filtering for `text_present`
   * (verifier dashboard self-test against prompt leakage).
   */
  selfTestTargetBaseUrl?: string;
  allowShellMetacharacters?: boolean;
};

export type VerifyInput = {
  spec: SpecIR;
  target: VerifyTarget;
  capabilities: CapabilitySet;
  integrations: ExecutorIntegrations;
  constraints?: VerifyConstraints;
};

function llmRowFields(llm?: LlmPolicy): {
  llm_provider: string | null;
  llm_model: string | null;
} {
  return summarizeLlmPolicyForRun(llm);
}

/**
 * Kernel entrypoint.
 * This is intentionally strict about lifecycle phases and returns a single result object.
 */
export async function verify(input: VerifyInput): Promise<VerificationResult> {
  const runId = randomUUID();
  const start = performance.now();
  const createdAt = new Date().toISOString();
  const c = input.constraints;

  const plan = planProbes(input.spec, input.capabilities, {
    isolateSessions: c?.isolateProbeSessions === true,
  });

  const outRoot = c?.outDir ?? ".verifier";
  const artifactRoot = outRoot.endsWith("artifacts")
    ? outRoot
    : join(outRoot, "artifacts");
  if (typeof c?.artifactMaxRuns === "number" && c.artifactMaxRuns > 0) {
    pruneArtifactRuns(artifactRoot, c.artifactMaxRuns);
  }
  const artifactStore = new ArtifactStore({ rootDir: artifactRoot, runId });

  const dbPath = join(outRoot, "verifier.sqlite");
  const db = openDb(dbPath);
  migrate(db);

  const llmRow = llmRowFields(c?.llm);
  insertRun(db, {
    id: runId,
    created_at: createdAt,
    target_base_url: input.target.baseUrl,
    policy_name: c?.policyName ?? "read_only",
    llm_provider: llmRow.llm_provider,
    llm_model: llmRow.llm_model,
    status: "running",
    confidence: null,
    summary_md_path: null,
    report_json_path: null,
  });
  insertRequirements(
    db,
    input.spec.requirements.map((r) => ({
      run_id: runId,
      id: r.id,
      source_text: r.source_text,
      type: r.type,
      priority: r.priority,
    })),
  );

  const ac = new AbortController();
  const maxRunMs = c?.maxRunMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof maxRunMs === "number" && maxRunMs > 0) {
    timer = setTimeout(() => ac.abort(), maxRunMs);
  }

  try {
    const baseUrl = input.target.baseUrl.trim();
    const execOut = await executePlan({
      runId,
      plan,
      capabilities: input.capabilities,
      integrations: input.integrations,
      artifactStore,
      policyName: c?.policyName ?? "read_only",
      ...(baseUrl ? { targetUrl: baseUrl } : {}),
      ...(c?.runCommandAllowlist !== undefined
        ? { runCommandAllowlist: c.runCommandAllowlist }
        : {}),
      ...(typeof c?.stepRetries === "number"
        ? { stepRetries: c.stepRetries }
        : {}),
      ...(typeof c?.stepRetryDelayMs === "number"
        ? { stepRetryDelayMs: c.stepRetryDelayMs }
        : {}),
      ...(c?.allowShellMetacharacters === true
        ? { allowShellMetacharacters: true }
        : {}),
      abortSignal: ac.signal,
    });

    for (const a of execOut.artifacts) {
      insertArtifact(db, {
        id: a.id,
        run_id: runId,
        type: a.type,
        path: join(artifactRoot, a.path),
        sha256: a.sha256,
        created_at: a.createdAt,
        metadata_json: a.metadata ? JSON.stringify(a.metadata) : null,
      });
    }

    const requirementResults = judgeDeterministic({
      spec: input.spec,
      plan,
      toolCalls: execOut.toolCalls,
      artifacts: execOut.artifacts,
      artifactRootDir: artifactRoot,
      ...(c?.selfTestTargetBaseUrl !== undefined
        ? { selfTestTargetBaseUrl: c.selfTestTargetBaseUrl }
        : {}),
      targetBaseUrl: input.target.baseUrl,
    });

    for (const rr of requirementResults) {
      updateRequirementResult(db, runId, rr.requirement_id, {
        verdict: rr.verdict,
        confidence: rr.confidence,
        judgment_mode: rr.judgment_mode,
        why_failed_or_blocked: rr.why_failed_or_blocked ?? null,
        repair_hint: rr.repair_hint ?? null,
      });
    }

    const result = synthesizeResult({
      requirementResults,
      artifacts: execOut.artifacts,
      toolCalls: execOut.toolCalls.length,
      sessions: plan.sessions.length,
      durationMs: Math.round(performance.now() - start),
      blockedReasons: requirementResults
        .filter((r) => r.verdict === "blocked" && r.why_failed_or_blocked)
        .map((r) => r.why_failed_or_blocked as string),
      meta: { runId, targetBaseUrl: input.target.baseUrl },
    });

    let resultOut = result;
    if (c?.llm && c.llm.triage.provider !== "none") {
      const triageMd = await runTriageMarkdown({ policy: c.llm, result });
      if (triageMd) {
        const ref = artifactStore.writeText("llm_output", triageMd, {
          metadata: { phase: "triage", kind: "triage_md" },
        });
        insertArtifact(db, {
          id: ref.id,
          run_id: runId,
          type: ref.type,
          path: join(artifactRoot, ref.path),
          sha256: ref.sha256,
          created_at: ref.createdAt,
          metadata_json: ref.metadata ? JSON.stringify(ref.metadata) : null,
        });
        resultOut = VerificationResultSchema.parse({
          ...result,
          artifacts: [...result.artifacts, ref],
        });
      }
    }

    updateRunStatus(db, runId, resultOut.overall_status, resultOut.confidence);
    return VerificationResultSchema.parse(resultOut);
  } catch (err) {
    const aborted =
      (err instanceof Error && err.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "AbortError");
    if (aborted) {
      updateRunStatus(db, runId, "timed_out", 0);
      throw new VerifierError(
        "TIMEOUT",
        `Verify exceeded maxRunMs=${maxRunMs ?? 0}.`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    db.close();
  }
}
