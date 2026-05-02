import { readFileSync } from "node:fs";
import { listArtifacts } from "../persistence/repo/artifactRepo.js";
import { listProbes } from "../persistence/repo/probeRepo.js";
import { listRequirements } from "../persistence/repo/requirementRepo.js";
import { getRun } from "../persistence/repo/runRepo.js";
import { listToolCalls } from "../persistence/repo/toolCallRepo.js";
import type { OpsContext } from "./context.js";

export function getReport(ctx: OpsContext, input: { runId: string }) {
  const run = getRun(ctx.db, input.runId);
  if (!run?.report_json_path) throw new Error(`Unknown runId: ${input.runId}`);
  const json = readFileSync(run.report_json_path, "utf8");
  return JSON.parse(json);
}

export function getRunGraph(ctx: OpsContext, input: { runId: string }) {
  const run = getRun(ctx.db, input.runId);
  if (!run) throw new Error(`Unknown runId: ${input.runId}`);
  return {
    run,
    probes: listProbes(ctx.db, input.runId),
    toolCalls: listToolCalls(ctx.db, input.runId),
    artifacts: listArtifacts(ctx.db, input.runId),
    requirements: listRequirements(ctx.db, input.runId),
  };
}

export function explainFailure(
  ctx: OpsContext,
  input: { runId: string; requirementId: string },
) {
  const reqs = listRequirements(ctx.db, input.runId);
  const r = reqs.find((x) => x.id === input.requirementId);
  if (!r) throw new Error(`Requirement not found: ${input.requirementId}`);
  return {
    requirementId: input.requirementId,
    verdict: r.verdict,
    why: r.why_failed_or_blocked,
    repair_hint: r.repair_hint,
  };
}

export function getArtifact(
  ctx: OpsContext,
  input: { runId: string; artifactId: string },
) {
  const artifacts = listArtifacts(ctx.db, input.runId);
  const a = artifacts.find((x) => x.id === input.artifactId);
  if (!a) throw new Error(`Artifact not found: ${input.artifactId}`);
  return a;
}
