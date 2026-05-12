import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ArtifactStore } from "../../artifacts/store.js";
import { judgeWithSelfConsistency } from "../../evaluators/llmJudgePrimary.js";
import { executeToolCallPlan } from "../../executors/planExecutor.js";
import { findLatestLlmOutputByKind } from "../../persistence/repo/artifactRepo.js";
import { planWithSelfConsistency } from "../../planners/llmPlanner.js";
import { mergeButtonStyleEvidenceIfNeeded } from "../../planners/buttonStyleEvidence.js";
import {
  requiredPolicyForCapabilities,
  type TestPlanIR,
  TestPlanIRSchema,
  validatePlan,
} from "../../planners/planIr.js";
import type { PolicyName } from "../../policies/policy.js";
import type { IntegrationRuntime } from "../../plugins/runtime.js";
import { nowIso, persistLlmOutputJsonArtifact } from "./artifacts.js";
import type { VerifyRunContext } from "./context.js";
import { ARTIFACT_KIND_TEST_PLAN_IR } from "./types.js";

export type GenericLlmFlowResult = {
  execOut: { toolCalls: any[]; artifacts: any[] };
  requirementResults: any[];
  meta: Record<string, unknown>;
};

export async function runGenericLlmFlow(
  run: VerifyRunContext,
  integrationRuntime: IntegrationRuntime,
): Promise<GenericLlmFlowResult> {
  const specIr = run.specIr!;
  const meta: Record<string, unknown> = {};

  const toolCallId = randomUUID();
  const startedAtIso = nowIso();
  run.publish({
    type: "step_started",
    runId: run.runId,
    toolCallId,
    capability: "planning",
    action: "mcp_list_tools",
    startedAt: startedAtIso,
  });
  let mcpTools: Awaited<ReturnType<IntegrationRuntime["listMcpTools"]>>;
  try {
    mcpTools = await integrationRuntime.listMcpTools();
    run.publish({
      type: "step_finished",
      runId: run.runId,
      toolCallId,
      capability: "planning",
      action: "mcp_list_tools",
      startedAt: startedAtIso,
      endedAt: nowIso(),
      ok: true,
      result: { toolCount: mcpTools.length },
    });
  } catch (e) {
    run.publish({
      type: "step_finished",
      runId: run.runId,
      toolCallId,
      capability: "planning",
      action: "mcp_list_tools",
      startedAt: startedAtIso,
      endedAt: nowIso(),
      ok: false,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  const toolCallId2 = randomUUID();
  const startedAtIso2 = nowIso();
  let planned: { plan: TestPlanIR; meta: Record<string, unknown> };

  const toolDescriptors = mcpTools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
  }));

  if (run.restartFromPhase === "llm_plan") {
    run.publish({
      type: "step_started",
      runId: run.runId,
      toolCallId: toolCallId2,
      capability: "planning",
      action: "llm_plan_with_self_consistency",
      startedAt: startedAtIso2,
      args: { reusedFromRunId: run.parentRunId, skippedLlm: true },
    });
    if (!run.parentRunId) {
      throw new Error("restart from llm_plan requires restartFromRunId");
    }
    const planRow = findLatestLlmOutputByKind(
      run.ctx.db,
      run.parentRunId,
      ARTIFACT_KIND_TEST_PLAN_IR,
    );
    if (!planRow) {
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId: toolCallId2,
        capability: "planning",
        action: "llm_plan_with_self_consistency",
        startedAt: startedAtIso2,
        endedAt: nowIso(),
        ok: false,
        errorMessage: `cannot restart from llm_plan: parent run ${run.parentRunId} has no saved test_plan_ir artifact.`,
      });
      throw new Error(
        `cannot restart from llm_plan: parent run ${run.parentRunId} has no saved test_plan_ir artifact.`,
      );
    }
    const planJson = readFileSync(planRow.path, "utf8");
    const parsedPlan = TestPlanIRSchema.parse(JSON.parse(planJson) as unknown);
    const validation = validatePlan(parsedPlan, toolDescriptors);
    if (!validation.ok) {
      const msg = `Cached plan from parent run ${run.parentRunId} is incompatible with current MCP tool surface: ${validation.issues
        .slice(0, 5)
        .map((i) => i.message)
        .join("; ")}`;
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId: toolCallId2,
        capability: "planning",
        action: "llm_plan_with_self_consistency",
        startedAt: startedAtIso2,
        endedAt: nowIso(),
        ok: false,
        errorMessage: msg,
      });
      throw new Error(msg);
    }
    const mergedPlan = mergeButtonStyleEvidenceIfNeeded(specIr, parsedPlan);
    const validationMerged = validatePlan(mergedPlan, toolDescriptors);
    if (!validationMerged.ok) {
      const msg = `Cached plan invalid after style-evidence merge: ${validationMerged.issues
        .slice(0, 5)
        .map((i) => i.message)
        .join("; ")}`;
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId: toolCallId2,
        capability: "planning",
        action: "llm_plan_with_self_consistency",
        startedAt: startedAtIso2,
        endedAt: nowIso(),
        ok: false,
        errorMessage: msg,
      });
      throw new Error(msg);
    }
    planned = {
      plan: mergedPlan,
      meta: {
        resumedFromRunId: run.parentRunId,
        skippedLlm: true,
        validationScore: validationMerged.score,
      },
    };
    persistLlmOutputJsonArtifact({
      db: run.ctx.db,
      artifactsDir: run.artifactsDir,
      runId: run.runId,
      value: planned.plan,
      metadata: {
        phase: "planning",
        kind: ARTIFACT_KIND_TEST_PLAN_IR,
        copiedFromRunId: run.parentRunId,
      },
    });
    run.publish({
      type: "step_finished",
      runId: run.runId,
      toolCallId: toolCallId2,
      capability: "planning",
      action: "llm_plan_with_self_consistency",
      startedAt: startedAtIso2,
      endedAt: nowIso(),
      ok: true,
      result: planned.meta,
    });
  } else {
    run.publish({
      type: "step_started",
      runId: run.runId,
      toolCallId: toolCallId2,
      capability: "planning",
      action: "llm_plan_with_self_consistency",
      startedAt: startedAtIso2,
      args: { attempts: 5, llm: run.llmPolicy },
    });
    try {
      const out = await planWithSelfConsistency({
        llm: run.llmPolicy,
        spec: specIr,
        targetUrl: run.input.targetUrl,
        tools: mcpTools,
        attempts: 5,
        onSelectedModel: run.recordModel,
        plannerHints: integrationRuntime.plannerHints(),
        ...(run.dartProjectRoot
          ? { dartProjectRoot: run.dartProjectRoot }
          : {}),
      });
      const mergedPlan = mergeButtonStyleEvidenceIfNeeded(specIr, out.plan);
      const validationMerged = validatePlan(mergedPlan, toolDescriptors);
      if (!validationMerged.ok) {
        throw new Error(
          `Plan invalid after style-evidence merge: ${validationMerged.issues
            .slice(0, 8)
            .map((i) => i.message)
            .join("; ")}`,
        );
      }
      planned = {
        plan: mergedPlan,
        meta: out.meta as Record<string, unknown>,
      };
      persistLlmOutputJsonArtifact({
        db: run.ctx.db,
        artifactsDir: run.artifactsDir,
        runId: run.runId,
        value: planned.plan,
        metadata: { phase: "planning", kind: ARTIFACT_KIND_TEST_PLAN_IR },
      });
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId: toolCallId2,
        capability: "planning",
        action: "llm_plan_with_self_consistency",
        startedAt: startedAtIso2,
        endedAt: nowIso(),
        ok: true,
        result: planned.meta,
      });
    } catch (e) {
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId: toolCallId2,
        capability: "planning",
        action: "llm_plan_with_self_consistency",
        startedAt: startedAtIso2,
        endedAt: nowIso(),
        ok: false,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  if (!planned.plan.toolCalls.length) {
    planned.plan.toolCalls = integrationRuntime.defaultToolPlanFallback({
      targetUrl: run.input.targetUrl,
      ...(run.dartProjectRoot ? { dartProjectRoot: run.dartProjectRoot } : {}),
    });
  }

  const caps = new Set(planned.plan.toolCalls.map((c) => c.capability));
  const effectivePolicy: PolicyName =
    run.requestedPolicy === "read_only" &&
    requiredPolicyForCapabilities(caps) === "ui_only"
      ? "ui_only"
      : run.requestedPolicy;

  meta.llm_planner = planned.meta;

  const artifactStore = new ArtifactStore({
    rootDir: run.artifactsDir,
    runId: run.runId,
  });
  const execOut = await executeToolCallPlan({
    runId: run.runId,
    toolCalls: planned.plan.toolCalls,
    capabilities: integrationRuntime.capabilities,
    runtime: integrationRuntime,
    artifactStore,
    policyName: effectivePolicy,
    onEvent: (e) => {
      run.ctx.events.publish(e);
      run.opts?.onEvent?.(e);
    },
    ...(run.runAbortSignal ? { abortSignal: run.runAbortSignal } : {}),
  });

  const judgeId = randomUUID();
  const judgeStartedAt = nowIso();
  run.publish({
    type: "step_started",
    runId: run.runId,
    toolCallId: judgeId,
    capability: "judgment",
    action: "llm_judge_self_consistency",
    startedAt: judgeStartedAt,
    args: {
      requirementCount: specIr.requirements.length,
      attempts: 3,
    },
  });
  let judged: Awaited<ReturnType<typeof judgeWithSelfConsistency>>;
  try {
    judged = await judgeWithSelfConsistency({
      llm: run.llmPolicy,
      spec: specIr,
      plan: planned.plan,
      toolCalls: execOut.toolCalls,
      artifacts: execOut.artifacts,
      artifactRootDir: run.artifactsDir,
      attempts: 3,
      onSelectedModel: run.recordModel,
    });
  } catch (e) {
    run.publish({
      type: "step_finished",
      runId: run.runId,
      toolCallId: judgeId,
      capability: "judgment",
      action: "llm_judge_self_consistency",
      startedAt: judgeStartedAt,
      endedAt: nowIso(),
      ok: false,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  run.publish({
    type: "step_finished",
    runId: run.runId,
    toolCallId: judgeId,
    capability: "judgment",
    action: "llm_judge_self_consistency",
    startedAt: judgeStartedAt,
    endedAt: nowIso(),
    ok: true,
    result: judged.meta,
  });

  meta.llm_judge = judged.meta;

  return {
    execOut,
    requirementResults: judged.results,
    meta,
  };
}
