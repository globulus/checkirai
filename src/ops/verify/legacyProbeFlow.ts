import { randomUUID } from "node:crypto";
import { ArtifactStore } from "../../artifacts/store.js";
import { judgeDeterministic } from "../../evaluators/judge.js";
import { judgeLlmSecondPass } from "../../evaluators/llmJudge.js";
import { executePlan } from "../../executors/engine.js";
import type { ExecutorIntegrations } from "../../executors/integrations.js";
import { policyJudgeOrPlannerActive } from "../../llm/types.js";
import { insertProbes } from "../../persistence/repo/probeRepo.js";
import { planStepsWithLlm } from "../../planners/llmStepPlanner.js";
import { planProbes } from "../../planners/planner.js";
import type { PolicyName } from "../../policies/policy.js";
import type { IntegrationRuntime } from "../../plugins/runtime.js";
import { nowIso } from "./artifacts.js";
import type { VerifyRunContext } from "./context.js";

export type LegacyProbeFlowResult = {
  execOut: { toolCalls: any[]; artifacts: any[] };
  requirementResults: any[];
  meta: Record<string, unknown>;
};

export async function runLegacyProbeFlow(
  run: VerifyRunContext,
  integrationRuntime: IntegrationRuntime,
  integrations: ExecutorIntegrations,
): Promise<LegacyProbeFlowResult> {
  let specIr = run.specIr!;

  if (policyJudgeOrPlannerActive(run.llmPolicy) && integrations.chrome) {
    const probePlanId = randomUUID();
    const probePlanStarted = nowIso();
    run.publish({
      type: "step_started",
      runId: run.runId,
      toolCallId: probePlanId,
      capability: "planning",
      action: "plan_probe_steps",
      startedAt: probePlanStarted,
    });
    try {
      const chromeTools = await integrations.chrome.listTools();
      const planned = await planStepsWithLlm({
        spec: specIr,
        llm: run.llmPolicy,
        targetUrl: run.input.targetUrl,
        chromeTools,
      });
      specIr = planned.spec;
      run.specIr = specIr;
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId: probePlanId,
        capability: "planning",
        action: "plan_probe_steps",
        startedAt: probePlanStarted,
        endedAt: nowIso(),
        ok: true,
        result: { updatedSpec: true },
      });
    } catch {
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId: probePlanId,
        capability: "planning",
        action: "plan_probe_steps",
        startedAt: probePlanStarted,
        endedAt: nowIso(),
        ok: true,
        result: { continuedWithoutPlanner: true },
      });
    }
  }

  const plan = planProbes(specIr, integrationRuntime.capabilities, {
    isolateSessions: run.isolateProbeSessions === true,
  });
  const planNeedsInteract = plan.sessions.some((s) =>
    s.probes.some((p) => p.capabilityNeeds.includes("interact")),
  );
  const effectivePolicy: PolicyName =
    run.requestedPolicy === "read_only" && planNeedsInteract
      ? "ui_only"
      : run.requestedPolicy;

  insertProbes(
    run.ctx.db,
    plan.sessions.flatMap((s) =>
      s.probes.map((p) => ({
        id: p.id,
        run_id: run.runId,
        requirement_id: p.requirementId,
        strategy: p.strategy ?? null,
        side_effects: p.sideEffects ?? null,
        cost_hint: p.costHint ?? null,
      })),
    ),
  );

  const artifactStore = new ArtifactStore({
    rootDir: run.artifactsDir,
    runId: run.runId,
  });
  const execOut = await executePlan({
    runId: run.runId,
    plan,
    capabilities: integrationRuntime.capabilities,
    integrations,
    artifactStore,
    policyName: effectivePolicy,
    targetUrl: run.input.targetUrl,
    ...(run.runAbortSignal ? { abortSignal: run.runAbortSignal } : {}),
    ...(run.runCommandAllowlist !== undefined
      ? { runCommandAllowlist: run.runCommandAllowlist }
      : {}),
    ...(run.allowShellMetacharacters ? { allowShellMetacharacters: true } : {}),
    ...(typeof run.stepRetries === "number"
      ? { stepRetries: run.stepRetries }
      : {}),
    ...(typeof run.stepRetryDelayMs === "number"
      ? { stepRetryDelayMs: run.stepRetryDelayMs }
      : {}),
    onEvent: (e) => {
      run.ctx.events.publish(e);
      run.opts?.onEvent?.(e);
    },
  });

  let requirementResults = judgeDeterministic({
    spec: specIr,
    plan,
    toolCalls: execOut.toolCalls,
    artifacts: execOut.artifacts,
    artifactRootDir: run.artifactsDir,
    ...(typeof run.input.selfTestTargetBaseUrl === "string"
      ? { selfTestTargetBaseUrl: run.input.selfTestTargetBaseUrl }
      : {}),
    targetBaseUrl: run.input.targetUrl,
  });

  let llmSecondPassMeta:
    | { attempted: number; applied: number }
    | { attempted: number; applied: number; error: string }
    | undefined;
  if (run.llmPolicy.judge.provider !== "none") {
    const inconclusiveIds = requirementResults
      .filter((r) => r.verdict === "inconclusive")
      .map((r) => r.requirement_id);
    if (inconclusiveIds.length) {
      const secondPassId = randomUUID();
      const secondPassStarted = nowIso();
      run.publish({
        type: "step_started",
        runId: run.runId,
        toolCallId: secondPassId,
        capability: "judgment",
        action: "llm_judge_second_pass",
        startedAt: secondPassStarted,
        args: { inconclusiveCount: inconclusiveIds.length },
      });
      try {
        const before = new Map(
          requirementResults.map((r) => [r.requirement_id, r.verdict] as const),
        );
        const out = await judgeLlmSecondPass(
          {
            spec: specIr,
            plan,
            toolCalls: execOut.toolCalls,
            artifacts: execOut.artifacts,
            artifactRootDir: run.artifactsDir,
            llm: run.llmPolicy,
            requirementIds: inconclusiveIds,
          },
          requirementResults,
          { onSelectedModel: run.recordModel },
        );
        requirementResults = out.results;
        const applied = requirementResults.filter((r) => {
          const prev = before.get(r.requirement_id);
          return (
            prev === "inconclusive" && r.judgment_mode === "model_assisted"
          );
        }).length;
        llmSecondPassMeta = {
          attempted: inconclusiveIds.length,
          applied,
        };
        run.publish({
          type: "step_finished",
          runId: run.runId,
          toolCallId: secondPassId,
          capability: "judgment",
          action: "llm_judge_second_pass",
          startedAt: secondPassStarted,
          endedAt: nowIso(),
          ok: true,
          result: llmSecondPassMeta,
        });
      } catch (e) {
        llmSecondPassMeta = {
          attempted: inconclusiveIds.length,
          applied: 0,
          error: e instanceof Error ? e.message : String(e),
        };
        run.publish({
          type: "step_finished",
          runId: run.runId,
          toolCallId: secondPassId,
          capability: "judgment",
          action: "llm_judge_second_pass",
          startedAt: secondPassStarted,
          endedAt: nowIso(),
          ok: false,
          errorMessage: e instanceof Error ? e.message : String(e),
          result: llmSecondPassMeta,
        });
      }
    }
  }

  return {
    execOut,
    requirementResults,
    meta: { llm_second_pass: llmSecondPassMeta },
  };
}
