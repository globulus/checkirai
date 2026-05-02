import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactRef } from "../artifacts/types.js";
import type { CapabilitySet } from "../capabilities/types.js";
import { assertPolicyAllows, getPolicy } from "../policies/policy.js";
import { VerifierError } from "../shared/errors.js";
import type { RunEventSink } from "../ops/events.js";
import type { ToolCallIR } from "../planners/planIr.js";
import type { ExecutorIntegrations } from "./integrations.js";
import type { ToolCallRecord } from "./types.js";

export type PlanExecutionOutput = {
  toolCalls: ToolCallRecord[];
  artifacts: ArtifactRef[];
};

function nowIso() {
  return new Date().toISOString();
}

function extractMcpText(res: unknown): string {
  const r = res as {
    structuredContent?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  if (typeof r.structuredContent === "string") return r.structuredContent;
  const text = r.content
    ?.map((c) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
  if (typeof text === "string" && text.trim()) return text;
  return JSON.stringify(res, null, 2);
}

function tryParseJsonFence(text: string): unknown | undefined {
  const m = text.match(/```json\\s*([\\s\\S]*?)\\s*```/i);
  const payload = m?.[1]?.trim();
  if (!payload) return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (!timeoutMs) return await p;
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new VerifierError(
              "TIMEOUT",
              `Timed out after ${timeoutMs}ms: ${label}`,
              {
                details: { timeoutMs, label },
              },
            ),
          ),
        timeoutMs,
      ),
    ),
  ]);
}

export async function executeToolCallPlan(opts: {
  runId: string;
  toolCalls: ToolCallIR[];
  capabilities: CapabilitySet;
  integrations: ExecutorIntegrations;
  artifactStore: ArtifactStore;
  policyName: "read_only" | "ui_only";
  onEvent?: RunEventSink;
}): Promise<PlanExecutionOutput> {
  const toolCalls: ToolCallRecord[] = [];
  const artifacts: ArtifactRef[] = [];

  for (const step of opts.toolCalls) {
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

      let output: unknown;
      if (step.capability === "navigate") {
        if (!opts.integrations.chrome)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Chrome DevTools integration not configured.",
          );
        const url = String((step.args as Record<string, unknown>)?.url ?? "");
        await withTimeout(
          opts.integrations.chrome.navigate(url),
          step.timeoutMs,
          "navigate",
        );
        output = { ok: true, url };
      } else if (step.capability === "call_http") {
        if (!opts.integrations.http)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "HTTP integration not configured.",
          );
        const url = String((step.args as Record<string, unknown>)?.url ?? "");
        output = await withTimeout(
          opts.integrations.http.get(url),
          step.timeoutMs,
          "http.get",
        );
      } else if (
        step.capability === "read_ui_structure" ||
        step.capability === "read_visual" ||
        step.capability === "interact" ||
        step.capability === "read_console" ||
        step.capability === "read_network"
      ) {
        if (!opts.integrations.chrome)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Chrome DevTools integration not configured.",
          );

        // Preserve legacy semantics: these two actions should emit dedicated artifacts
        // that downstream judges already know how to consume.
        if (
          step.capability === "read_ui_structure" &&
          step.tool === "take_snapshot"
        ) {
          const { snapshot, artifact } = await withTimeout(
            opts.integrations.chrome.takeSnapshot(opts.artifactStore),
            step.timeoutMs,
            "take_snapshot",
          );
          artifacts.push(artifact);
          output = {
            snapshotText: snapshot.snapshotText,
            artifactId: artifact.id,
            ...(step.label ? { label: step.label } : {}),
          };
        } else if (
          step.capability === "read_visual" &&
          step.tool === "take_screenshot"
        ) {
          const artifact = await withTimeout(
            opts.integrations.chrome.takeScreenshot(
              opts.artifactStore,
              step.label,
            ),
            step.timeoutMs,
            "take_screenshot",
          );
          artifacts.push(artifact);
          output = {
            artifactId: artifact.id,
            ...(step.label ? { label: step.label } : {}),
          };
        } else {
          const res = await withTimeout(
            opts.integrations.chrome.call(step.tool, step.args ?? {}),
            step.timeoutMs,
            step.tool,
          );

          if (step.tool === "evaluate_script") {
            const responseText = extractMcpText(res);
            const parsed = tryParseJsonFence(responseText);
            output = {
              response: res,
              responseText,
              ...(parsed !== undefined ? { parsedJson: parsed } : {}),
            };
          } else {
            output = {
              response: res,
              ...(step.label ? { label: step.label } : {}),
            };
          }
        }
      } else if (step.capability === "read_files") {
        if (!opts.integrations.fs)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "FS integration not configured.",
          );
        const path = String((step.args as Record<string, unknown>)?.path ?? "");
        output = { path, text: opts.integrations.fs.readText(path) };
      } else {
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Unsupported capability in plan executor: ${step.capability}`,
        );
      }

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
