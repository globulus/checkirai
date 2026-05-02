import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ArtifactStore } from "../artifacts/store.js";
import type { CapabilitySet } from "../capabilities/types.js";
import { judgeDeterministic } from "../evaluators/judge.js";
import { executePlan } from "../executors/engine.js";
import type { ExecutorIntegrations } from "../executors/integrations.js";
import type { LlmPolicy } from "../llm/types.js";
import { migrate, openDb } from "../persistence/db.js";
import { insertArtifact } from "../persistence/repo/artifactRepo.js";
import {
  insertRequirements,
  updateRequirementResult,
} from "../persistence/repo/requirementRepo.js";
import { insertRun, updateRunStatus } from "../persistence/repo/runRepo.js";
import { planProbes } from "../planners/planner.js";
import type { SpecIR } from "../spec/ir.js";
import { type VerificationResult, VerificationResultSchema } from "./result.js";
import { synthesizeResult } from "./synthesize.js";

export type VerifyTarget = {
  baseUrl: string;
  launchCommand?: string;
};

export type VerifyConstraints = {
  policyName?: "read_only" | "ui_only";
  llm?: LlmPolicy;
  outDir?: string;
};

export type VerifyInput = {
  spec: SpecIR;
  target: VerifyTarget;
  capabilities: CapabilitySet;
  integrations: ExecutorIntegrations;
  constraints?: VerifyConstraints;
};

/**
 * Kernel entrypoint.
 * This is intentionally strict about lifecycle phases and returns a single result object.
 */
export async function verify(input: VerifyInput): Promise<VerificationResult> {
  const runId = randomUUID();
  const start = performance.now();
  const createdAt = new Date().toISOString();

  // Phase 1: context resolution (minimal MVP: already resolved by caller)
  // Phase 2: spec normalization (MVP: caller provides SpecIR)
  // Phase 3: planning
  const plan = planProbes(input.spec, input.capabilities);

  // Phase 4: execution
  const outRoot = input.constraints?.outDir ?? ".verifier";
  const artifactRoot = outRoot.endsWith("artifacts")
    ? outRoot
    : join(outRoot, "artifacts");
  const artifactStore = new ArtifactStore({ rootDir: artifactRoot, runId });

  // Persistence (SQLite): store the run graph as we go.
  const dbPath = join(outRoot, "verifier.sqlite");
  const db = openDb(dbPath);
  migrate(db);
  insertRun(db, {
    id: runId,
    created_at: createdAt,
    target_base_url: input.target.baseUrl,
    policy_name: input.constraints?.policyName ?? "read_only",
    llm_provider: input.constraints?.llm?.provider ?? null,
    llm_model:
      input.constraints?.llm?.provider === "ollama"
        ? (input.constraints?.llm?.ollamaModel ?? null)
        : null,
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
  const execOut = await executePlan({
    runId,
    plan,
    capabilities: input.capabilities,
    integrations: input.integrations,
    artifactStore,
    policyName: input.constraints?.policyName ?? "read_only",
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

  // Phase 5: judgment
  const requirementResults = judgeDeterministic({
    spec: input.spec,
    plan,
    toolCalls: execOut.toolCalls,
    artifacts: execOut.artifacts,
    artifactRootDir: artifactRoot,
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

  // Phase 6: synthesis
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

  updateRunStatus(db, runId, result.overall_status, result.confidence);
  return VerificationResultSchema.parse(result);
}
