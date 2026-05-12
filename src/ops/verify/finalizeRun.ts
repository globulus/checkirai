import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ArtifactStore } from "../../artifacts/store.js";
import {
  synthesizeMarkdownSummary,
  synthesizeResult,
} from "../../core/synthesize.js";
import { runTriageMarkdown } from "../../evaluators/triageRun.js";
import { insertArtifact } from "../../persistence/repo/artifactRepo.js";
import { updateRequirementResult } from "../../persistence/repo/requirementRepo.js";
import { updateRunStatus } from "../../persistence/repo/runRepo.js";
import { insertToolCalls } from "../../persistence/repo/toolCallRepo.js";
import { ensureDir, nowIso } from "./artifacts.js";
import type { VerifyRunContext } from "./context.js";

export async function finalizeRun(
  run: VerifyRunContext,
  execOut: { toolCalls: any[]; artifacts: any[] },
  requirementResults: any[],
  metaExtra: Record<string, unknown>,
) {
  for (const a of execOut.artifacts) {
    insertArtifact(run.ctx.db, {
      id: a.id,
      run_id: run.runId,
      type: a.type,
      path: join(run.artifactsDir, a.path),
      sha256: a.sha256,
      created_at: a.createdAt,
      metadata_json: a.metadata ? JSON.stringify(a.metadata) : null,
    });
  }

  insertToolCalls(
    run.ctx.db,
    execOut.toolCalls.map((t) => ({
      id: t.id,
      run_id: run.runId,
      probe_id: t.probeId ?? null,
      capability: t.capability,
      action: t.action,
      started_at: t.startedAt,
      ended_at: t.endedAt,
      ok: t.ok ? 1 : 0,
      error_code: t.errorCode ?? null,
      error_message: t.errorMessage ?? null,
      output_artifact_id: t.outputArtifactId ?? null,
    })),
  );

  for (const rr of requirementResults) {
    updateRequirementResult(run.ctx.db, run.runId, rr.requirement_id, {
      verdict: rr.verdict,
      confidence: rr.confidence,
      judgment_mode: rr.judgment_mode,
      why_failed_or_blocked: rr.why_failed_or_blocked ?? null,
      repair_hint: rr.repair_hint ?? null,
    });
  }

  const durationMs = Math.round(performance.now() - run.start);
  const result = synthesizeResult({
    requirementResults,
    artifacts: execOut.artifacts,
    toolCalls: execOut.toolCalls.length,
    sessions: 1,
    durationMs,
    blockedReasons: requirementResults
      .filter((r) => r.verdict === "blocked" && r.why_failed_or_blocked)
      .map((r) => r.why_failed_or_blocked as string),
    meta: {
      runId: run.runId,
      targetBaseUrl: run.input.targetUrl,
      ...metaExtra,
    },
  });

  let resultOut = result;
  if (run.llmPolicy.triage.provider !== "none") {
    const triageId = randomUUID();
    const triageStarted = nowIso();
    run.publish({
      type: "step_started",
      runId: run.runId,
      toolCallId: triageId,
      capability: "triage",
      action: "summarize_run",
      startedAt: triageStarted,
    });
    let triageMd: string;
    try {
      triageMd = await runTriageMarkdown({
        policy: run.llmPolicy,
        result,
        hooks: { onSelectedModel: run.recordModel },
      });
    } catch (e) {
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId: triageId,
        capability: "triage",
        action: "summarize_run",
        startedAt: triageStarted,
        endedAt: nowIso(),
        ok: false,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    run.publish({
      type: "step_finished",
      runId: run.runId,
      toolCallId: triageId,
      capability: "triage",
      action: "summarize_run",
      startedAt: triageStarted,
      endedAt: nowIso(),
      ok: true,
      result: { chars: triageMd.length },
    });
    if (triageMd.trim()) {
      const store = new ArtifactStore({
        rootDir: run.artifactsDir,
        runId: run.runId,
      });
      const ref = store.writeText("llm_output", triageMd, {
        ext: "md",
        metadata: { phase: "triage", kind: "triage_md" },
      });
      insertArtifact(run.ctx.db, {
        id: ref.id,
        run_id: run.runId,
        type: ref.type,
        path: join(run.artifactsDir, ref.path),
        sha256: ref.sha256,
        created_at: ref.createdAt,
        metadata_json: ref.metadata ? JSON.stringify(ref.metadata) : null,
      });
      resultOut = {
        ...result,
        artifacts: [...result.artifacts, ref],
      };
    }
  }

  const runDir = join(run.runsDir, run.runId);
  ensureDir(runDir);
  const reportPath = join(runDir, "report.json");
  const summaryPath = join(runDir, "summary.md");
  writeFileSync(reportPath, JSON.stringify(resultOut, null, 2), "utf8");
  writeFileSync(summaryPath, synthesizeMarkdownSummary(resultOut), "utf8");

  updateRunStatus(
    run.ctx.db,
    run.runId,
    resultOut.overall_status,
    resultOut.confidence,
  );

  const stmt = run.ctx.db.prepare(`
    UPDATE runs
    SET summary_md_path = @summary_md_path,
        report_json_path = @report_json_path
    WHERE id = @id
  `);
  stmt.run({
    id: run.runId,
    summary_md_path: summaryPath,
    report_json_path: reportPath,
  });

  const endedAt = nowIso();
  run.ctx.events.publish({
    type: "run_finished",
    runId: run.runId,
    endedAt,
    status: resultOut.overall_status,
    confidence: resultOut.confidence,
  });
  run.opts?.onEvent?.({
    type: "run_finished",
    runId: run.runId,
    endedAt,
    status: resultOut.overall_status,
    confidence: resultOut.confidence,
  });

  return { runId: run.runId, result: resultOut };
}
