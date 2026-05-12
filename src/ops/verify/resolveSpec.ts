import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createFsIntegration } from "../../integrations/fs/fsIntegration.js";
import { createHttpIntegration } from "../../integrations/http/httpIntegration.js";
import { findLatestLlmOutputByKind } from "../../persistence/repo/artifactRepo.js";
import { resolveSpecBundle } from "../../spec/contextResolution.js";
import { SpecIRSchema } from "../../spec/ir.js";
import { normalizeMarkdownToSpecIRWithLlmDetailed } from "../../spec/normalize.js";
import { nowIso, persistLlmOutputJsonArtifact } from "./artifacts.js";
import type { VerifyRunContext } from "./context.js";
import { ARTIFACT_KIND_SPEC_IR } from "./types.js";

export async function resolveSpec(run: VerifyRunContext) {
  let specIr = run.specIr;

  if (
    (run.restartFromPhase === "spec_ir" ||
      run.restartFromPhase === "llm_plan") &&
    run.parentRunId
  ) {
    const row = findLatestLlmOutputByKind(
      run.ctx.db,
      run.parentRunId,
      ARTIFACT_KIND_SPEC_IR,
    );
    if (!row) {
      throw new Error(
        `cannot restart from ${run.restartFromPhase}: parent run ${run.parentRunId} has no saved spec_ir artifact (re-run verification from start on that spec first).`,
      );
    }
    const raw = readFileSync(row.path, "utf8");
    specIr = SpecIRSchema.parse(JSON.parse(raw) as unknown);
  } else if (run.input.specMarkdown) {
    const toolCallId = randomUUID();
    const startedAtIso = nowIso();
    run.publish({
      type: "step_started",
      runId: run.runId,
      toolCallId,
      capability: "spec_normalization",
      action: "normalize_markdown",
      startedAt: startedAtIso,
      args: { llm: run.llmPolicy, specChars: run.input.specMarkdown.length },
    });
    const out = await normalizeMarkdownToSpecIRWithLlmDetailed(
      run.input.specMarkdown,
      run.llmPolicy,
      {
        ...(run.runAbortSignal ? { abortSignal: run.runAbortSignal } : {}),
        onLlmCall: (e) => {
          run.recordModel(e.model);
          run.publish({
            type: "llm_call",
            runId: run.runId,
            startedAt: startedAtIso,
            endedAt: nowIso(),
            phase: e.phase,
            provider: e.provider,
            host: e.host ?? "",
            model: e.model,
            durationMs: e.durationMs,
            promptChars: e.promptChars,
            responseChars: e.responseChars,
            truncated: e.truncated,
            ...(e.system ? { system: e.system } : {}),
            prompt: e.prompt,
            responseText: e.responseText,
          });
        },
      },
    );
    specIr = out.specIr;
    run.publish({
      type: "step_finished",
      runId: run.runId,
      toolCallId,
      capability: "spec_normalization",
      action: "normalize_markdown",
      startedAt: startedAtIso,
      endedAt: nowIso(),
      ok: true,
      result: out.meta,
    });
  } else if (run.input.spec) {
    specIr = run.input.spec;
  }

  if (run.input.specBundle) {
    const resolved = await resolveSpecBundle(run.input.specBundle, {
      http: createHttpIntegration(),
      fs: createFsIntegration(),
    });
    const toolCallId = randomUUID();
    const startedAtIso = nowIso();
    run.publish({
      type: "step_started",
      runId: run.runId,
      toolCallId,
      capability: "spec_normalization",
      action: "normalize_bundle",
      startedAt: startedAtIso,
      args: { llm: run.llmPolicy, specChars: resolved.combinedMarkdown.length },
    });
    const out = await normalizeMarkdownToSpecIRWithLlmDetailed(
      resolved.combinedMarkdown,
      run.llmPolicy,
      {
        ...(run.runAbortSignal ? { abortSignal: run.runAbortSignal } : {}),
        onLlmCall: (e) => {
          run.recordModel(e.model);
          run.publish({
            type: "llm_call",
            runId: run.runId,
            startedAt: startedAtIso,
            endedAt: nowIso(),
            phase: e.phase,
            provider: e.provider,
            host: e.host ?? "",
            model: e.model,
            durationMs: e.durationMs,
            promptChars: e.promptChars,
            responseChars: e.responseChars,
            truncated: e.truncated,
            ...(e.system ? { system: e.system } : {}),
            prompt: e.prompt,
            responseText: e.responseText,
          });
        },
      },
    );
    specIr = out.specIr;
    run.publish({
      type: "step_finished",
      runId: run.runId,
      toolCallId,
      capability: "spec_normalization",
      action: "normalize_bundle",
      startedAt: startedAtIso,
      endedAt: nowIso(),
      ok: true,
      result: out.meta,
    });
  }

  if (!specIr) {
    throw new Error("Missing spec input (specMarkdown|spec|specBundle).");
  }

  persistLlmOutputJsonArtifact({
    db: run.ctx.db,
    artifactsDir: run.artifactsDir,
    runId: run.runId,
    value: specIr,
    metadata: { phase: "spec_normalization", kind: ARTIFACT_KIND_SPEC_IR },
  });

  run.publish({
    type: "run_started",
    runId: run.runId,
    createdAt: run.createdAt,
    meta: {
      targetUrl: run.input.targetUrl,
      specIr,
      ...(run.lineageParent
        ? {
            parentRunId: run.lineageParent,
            restartFromPhase: run.restartFromPhase,
          }
        : {}),
    },
  });

  run.specIr = specIr;
}
