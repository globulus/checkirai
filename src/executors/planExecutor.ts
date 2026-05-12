import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactRef } from "../artifacts/types.js";
import type { CapabilitySet } from "../capabilities/types.js";
import type { RunEventSink } from "../ops/events.js";
import type { IntegrationRuntime } from "../plugins/runtime.js";
import type { ToolCallIR } from "../planners/planIr.js";
import { assertPolicyAllows, getPolicy } from "../policies/policy.js";
import { VerifierError } from "../shared/errors.js";
import type { ToolCallRecord } from "./types.js";

export type PlanExecutionOutput = {
  toolCalls: ToolCallRecord[];
  artifacts: ArtifactRef[];
};

function nowIso() {
  return new Date().toISOString();
}

export async function executeToolCallPlan(opts: {
  runId: string;
  toolCalls: ToolCallIR[];
  capabilities: CapabilitySet;
  runtime: IntegrationRuntime;
  artifactStore: ArtifactStore;
  policyName: "read_only" | "ui_only";
  onEvent?: RunEventSink;
  abortSignal?: AbortSignal;
}): Promise<PlanExecutionOutput> {
  const toolCalls: ToolCallRecord[] = [];
  const artifacts: ArtifactRef[] = [];

  for (const step of opts.toolCalls) {
    opts.abortSignal?.throwIfAborted();
    const id = randomUUID();
    const startedAt = nowIso();

    opts.onEvent?.({
      type: "step_started",
      runId: opts.runId,
      toolCallId: id,
      capability: step.capability,
      action: step.tool,
      startedAt,
      args: step.args,
    });

    const mk = (
      ok: boolean,
      patch?: Partial<ToolCallRecord>,
    ): ToolCallRecord => ({
      id,
      runId: opts.runId,
      capability: step.capability,
      action: step.tool,
      startedAt,
      endedAt: nowIso(),
      ok,
      ...patch,
    });

    try {
      if (!opts.capabilities.has(step.capability)) {
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Capability not available: ${step.capability}`,
        );
      }
      assertPolicyAllows(getPolicy(opts.policyName), step.capability);

      const { output, artifacts: stepArtifacts = [] } =
        await opts.runtime.executeStep(step, {
          artifactStore: opts.artifactStore,
          runId: opts.runId,
          ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        });
      artifacts.push(...stepArtifacts);

      const artifact = opts.artifactStore.writeJson("tool_output", output, {
        metadata: {
          capability: step.capability,
          action: step.tool,
          label: step.label,
        },
      });
      toolCalls.push(mk(true, { outputArtifactId: artifact.id }));
      artifacts.push(artifact);

      opts.onEvent?.({
        type: "step_finished",
        runId: opts.runId,
        toolCallId: id,
        capability: step.capability,
        action: step.tool,
        startedAt,
        endedAt: nowIso(),
        ok: true,
        result: { outputArtifactId: artifact.id },
      });
    } catch (err) {
      const e =
        err instanceof VerifierError
          ? err
          : new VerifierError("TOOL_UNAVAILABLE", "Step failed.", {
              cause: err,
            });
      const artifact = opts.artifactStore.writeJson(
        "tool_output",
        { error: { code: e.code, message: e.message, details: e.details } },
        { metadata: { failed: true } },
      );
      toolCalls.push(
        mk(false, {
          errorCode: e.code,
          errorMessage: e.message,
          outputArtifactId: artifact.id,
        }),
      );
      artifacts.push(artifact);

      opts.onEvent?.({
        type: "step_finished",
        runId: opts.runId,
        toolCallId: id,
        capability: step.capability,
        action: step.tool,
        startedAt,
        endedAt: nowIso(),
        ok: false,
        errorCode: e.code,
        errorMessage: e.message,
        result: { outputArtifactId: artifact.id },
      });
    }
  }

  return { toolCalls, artifacts };
}
