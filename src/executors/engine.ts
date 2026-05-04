import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactRef } from "../artifacts/types.js";
import { Capability, type CapabilitySet } from "../capabilities/types.js";
import type { RunEventSink } from "../ops/events.js";
import type { Probe, ProbePlan, ProbeStep } from "../planners/types.js";
import { assertPolicyAllows, getPolicy } from "../policies/policy.js";
import { VerifierError } from "../shared/errors.js";
import {
  hasShellMetacharacters,
  isRunCommandAllowlisted,
} from "../shared/runCommandAllowlist.js";
import type { ExecutorIntegrations } from "./integrations.js";
import type { ToolCallRecord } from "./types.js";

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

type RunStepContext = {
  runId: string;
  probeId?: string;
  capabilities: CapabilitySet;
  integrations: ExecutorIntegrations;
  store: ArtifactStore;
  policyName: "read_only" | "ui_only";
  onEvent?: RunEventSink;
  abortSignal?: AbortSignal;
  /** When empty or undefined, all `run_command` steps are denied. */
  runCommandAllowlist?: string[];
  /** When true, allows shell metacharacters in `run_command` command/args (default false). */
  allowShellMetacharacters?: boolean;
};

export type ExecutionOutput = {
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
  // Common chrome-devtools-mcp shape:
  // Script ran on page and returned:
  // ```json
  // [...]
  // ```
  const m = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const payload = m?.[1]?.trim();
  if (!payload) return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

async function runStep(
  step: ProbeStep,
  ctx: RunStepContext,
): Promise<{
  toolCall: ToolCallRecord;
  artifacts: ArtifactRef[];
  output?: unknown;
}> {
  const {
    runId,
    probeId,
    capabilities,
    integrations,
    store,
    policyName,
    onEvent,
    abortSignal,
    runCommandAllowlist,
  } = ctx;
  const id = randomUUID();
  const startedAt = nowIso();

  if (onEvent) {
    const ev: {
      type: "step_started";
      runId: string;
      toolCallId: string;
      capability: string;
      action: string;
      startedAt: string;
      probeId?: string;
      args?: unknown;
    } = {
      type: "step_started",
      runId,
      toolCallId: id,
      capability: step.capability,
      action: step.action,
      startedAt,
      ...(step.args ? { args: step.args } : {}),
    };
    if (probeId) ev.probeId = probeId;
    onEvent(ev);
  }

  const mk = (ok: boolean, patch?: Partial<ToolCallRecord>) => {
    const base: ToolCallRecord = {
      id,
      runId,
      capability: step.capability,
      action: step.action,
      startedAt,
      endedAt: nowIso(),
      ok,
      ...patch,
    };
    if (probeId) base.probeId = probeId;
    return base;
  };

  try {
    abortSignal?.throwIfAborted();
    if (!capabilities.has(step.capability)) {
      throw new VerifierError(
        "TOOL_UNAVAILABLE",
        `Capability not available: ${step.capability}`,
      );
    }
    assertPolicyAllows(getPolicy(policyName), step.capability);

    let output: unknown;
    switch (step.capability) {
      case Capability.read_files: {
        if (!integrations.fs)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "FS integration not configured.",
          );
        const path = String(step.args?.path ?? "");
        output = { path, text: integrations.fs.readText(path) };
        break;
      }
      case Capability.call_http: {
        if (!integrations.http)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "HTTP integration not configured.",
          );
        const url = String(step.args?.url ?? "");
        const resHttp = await integrations.http.get(url);
        output = { ...resHttp, url };
        break;
      }
      case Capability.navigate: {
        if (!integrations.chrome)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Chrome DevTools integration not configured.",
          );
        const url = String(step.args?.url ?? "");
        await integrations.chrome.navigate(url);
        output = { ok: true, url };
        break;
      }
      case Capability.read_ui_structure: {
        if (!integrations.chrome)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Chrome DevTools integration not configured.",
          );
        // If caller specifies an explicit tool name, use it; else default to take_snapshot.
        if (step.action && step.action !== "take_snapshot") {
          const res = await integrations.chrome.call(
            step.action,
            (step.args?.toolArgs as Record<string, unknown> | undefined) ?? {},
          );
          output = { response: res };
        } else {
          const { snapshot, artifact } =
            await integrations.chrome.takeSnapshot(store);
          const pageUrl = await integrations.chrome.getCurrentUrl();
          output = {
            snapshotText: snapshot.snapshotText,
            artifactId: artifact.id,
            ...(pageUrl ? { pageUrl } : {}),
          };
        }
        break;
      }
      case Capability.read_visual: {
        if (!integrations.chrome)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Chrome DevTools integration not configured.",
          );
        const label =
          typeof step.args?.label === "string"
            ? (step.args.label as string)
            : undefined;
        if (step.action && step.action !== "take_screenshot") {
          const res = await integrations.chrome.call(
            step.action,
            (step.args?.toolArgs as Record<string, unknown> | undefined) ?? {},
          );
          output = { response: res, label };
        } else {
          const artifact = await integrations.chrome.takeScreenshot(
            store,
            label,
          );
          output = { artifactId: artifact.id };
        }
        break;
      }
      case Capability.interact: {
        if (!integrations.chrome)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Chrome DevTools integration not configured.",
          );
        // If the planner specifies an explicit chrome-devtools tool, just call it.
        if (step.action && !["run_steps"].includes(step.action)) {
          const res = await integrations.chrome.call(
            step.action,
            (step.args ?? {}) as Record<string, unknown>,
          );
          // Try to structure common evidence payloads to help model-assisted judging.
          if (step.action === "evaluate_script") {
            const responseText = extractMcpText(res);
            const parsed = tryParseJsonFence(responseText);
            output = {
              response: res,
              responseText,
              ...(parsed !== undefined ? { parsedJson: parsed } : {}),
            };
          } else {
            output = { response: res };
          }
          break;
        }
        // MVP: support { kind: 'click_text', text } and { kind: 'type', text } and { kind: 'fill_text', needle, value }
        const kind = String(step.args?.kind ?? "");
        if (kind === "type") {
          const text = String(step.args?.text ?? "");
          await integrations.chrome.typeText(text);
          output = { ok: true };
          break;
        }
        // click/fill need a snapshot to find uid by needle
        const { snapshot } = await integrations.chrome.takeSnapshot(store);
        if (kind === "click_text") {
          const needle = String(step.args?.text ?? "");
          const uid = integrations.chrome.findUid(
            snapshot.snapshotText,
            needle,
          );
          if (!uid)
            throw new VerifierError(
              "TOOL_UNAVAILABLE",
              `Could not find element uid for text: ${needle}`,
            );
          await integrations.chrome.clickUid(uid);
          output = { ok: true, uid };
          break;
        }
        if (kind === "fill_text") {
          const needle = String(step.args?.needle ?? "");
          const value = String(step.args?.value ?? "");
          const uid = integrations.chrome.findUid(
            snapshot.snapshotText,
            needle,
          );
          if (!uid)
            throw new VerifierError(
              "TOOL_UNAVAILABLE",
              `Could not find element uid for: ${needle}`,
            );
          await integrations.chrome.fill(uid, value);
          output = { ok: true, uid };
          break;
        }
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Unsupported interact kind: ${kind}`,
        );
      }
      case Capability.read_console: {
        if (!integrations.chrome)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Chrome DevTools integration not configured.",
          );
        const res = await integrations.chrome.call(
          "list_console_messages",
          (step.args ?? {}) as Record<string, unknown>,
        );
        output = { response: res };
        break;
      }
      case Capability.read_network: {
        if (!integrations.chrome)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Chrome DevTools integration not configured.",
          );
        const res = await integrations.chrome.call(
          "list_network_requests",
          (step.args ?? {}) as Record<string, unknown>,
        );
        output = { response: res };
        break;
      }
      case Capability.run_command: {
        if (!integrations.shell)
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            "Shell integration not configured.",
          );
        const command = String(step.args?.command ?? "");
        const args = Array.isArray(step.args?.args)
          ? (step.args?.args as string[])
          : [];
        if (
          !isRunCommandAllowlisted(runCommandAllowlist ?? [], command, args)
        ) {
          throw new VerifierError(
            "POLICY_BLOCKED",
            "run_command is not allowlisted. Set runCommandAllowlist (prefix with * for prefix match).",
            { details: { command, args } },
          );
        }
        if (
          ctx.allowShellMetacharacters !== true &&
          (hasShellMetacharacters(command) ||
            args.some((a) => hasShellMetacharacters(String(a))))
        ) {
          throw new VerifierError(
            "POLICY_BLOCKED",
            "run_command rejected: shell metacharacters in command or args. Set allowShellMetacharacters to opt in.",
            { details: { command, args } },
          );
        }
        const runOpts: { cwd?: string; timeoutMs?: number } = {};
        if (typeof step.args?.cwd === "string")
          runOpts.cwd = step.args.cwd as string;
        if (typeof step.args?.timeoutMs === "number")
          runOpts.timeoutMs = step.args.timeoutMs as number;
        output = await integrations.shell.run(command, args, runOpts);
        break;
      }
      default:
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Executor does not yet support capability: ${step.capability}`,
        );
    }

    const artifact = store.writeJson("tool_output", output, {
      metadata: { capability: step.capability, action: step.action },
    });

    return {
      toolCall: mk(true, { outputArtifactId: artifact.id }),
      artifacts: [artifact],
      output,
    };
  } catch (err) {
    const e =
      err instanceof VerifierError
        ? err
        : new VerifierError("TOOL_UNAVAILABLE", "Step failed.", { cause: err });
    const artifact = store.writeJson(
      "tool_output",
      { error: { code: e.code, message: e.message, details: e.details } },
      { metadata: { failed: true } },
    );
    return {
      toolCall: mk(false, {
        errorCode: e.code,
        errorMessage: e.message,
        outputArtifactId: artifact.id,
      }),
      artifacts: [artifact],
    };
  }
}

async function runProbe(
  probe: Probe,
  ctx: RunStepContext & {
    stepRetries?: number;
    stepRetryDelayMs?: number;
    allowShellMetacharacters?: boolean;
  },
): Promise<ExecutionOutput> {
  const toolCalls: ToolCallRecord[] = [];
  const artifacts: ArtifactRef[] = [];
  const stepRetries = ctx.stepRetries ?? 0;
  const stepRetryDelayMs = ctx.stepRetryDelayMs ?? 400;

  ctx.onEvent?.({
    type: "probe_started",
    runId: ctx.runId,
    probeId: probe.id,
    requirementId: probe.requirementId,
  });

  const stepCtx: RunStepContext = { ...ctx, probeId: probe.id };

  for (const step of probe.steps) {
    let res = await runStep(step, stepCtx);
    let attempt = 0;
    while (!res.toolCall.ok && attempt < stepRetries) {
      ctx.abortSignal?.throwIfAborted();
      attempt += 1;
      await delay(stepRetryDelayMs);
      res = await runStep(step, stepCtx);
    }
    toolCalls.push(res.toolCall);
    artifacts.push(...res.artifacts);

    const finished = {
      type: "step_finished" as const,
      runId: ctx.runId,
      probeId: probe.id,
      toolCallId: res.toolCall.id,
      capability: res.toolCall.capability,
      action: res.toolCall.action,
      startedAt: res.toolCall.startedAt,
      endedAt: res.toolCall.endedAt,
      ok: res.toolCall.ok,
      ...(res.toolCall.errorCode ? { errorCode: res.toolCall.errorCode } : {}),
      ...(res.toolCall.errorMessage
        ? { errorMessage: res.toolCall.errorMessage }
        : {}),
      ...(res.toolCall.outputArtifactId
        ? { outputArtifactId: res.toolCall.outputArtifactId }
        : {}),
    };
    ctx.onEvent?.(finished);
  }

  return { toolCalls, artifacts };
}

export async function executePlan(opts: {
  runId: string;
  plan: ProbePlan;
  capabilities: CapabilitySet;
  integrations: ExecutorIntegrations;
  artifactStore: ArtifactStore;
  policyName: "read_only" | "ui_only";
  /**
   * Optional bootstrap navigation URL.
   * If provided and the `navigate` capability is available, the executor will
   * navigate once per session before running any probes.
   */
  targetUrl?: string;
  onEvent?: RunEventSink;
  abortSignal?: AbortSignal;
  runCommandAllowlist?: string[];
  stepRetries?: number;
  stepRetryDelayMs?: number;
  /**
   * When true (default), navigate back to `targetUrl` between probes in a session
   * to shed UI mutations from prior probes.
   */
  resetBetweenProbes?: boolean;
  allowShellMetacharacters?: boolean;
}): Promise<ExecutionOutput> {
  const toolCalls: ToolCallRecord[] = [];
  const artifacts: ArtifactRef[] = [];
  const baseCtx: RunStepContext = {
    runId: opts.runId,
    capabilities: opts.capabilities,
    integrations: opts.integrations,
    store: opts.artifactStore,
    policyName: opts.policyName,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.runCommandAllowlist !== undefined
      ? { runCommandAllowlist: opts.runCommandAllowlist }
      : {}),
    ...(opts.allowShellMetacharacters === true
      ? { allowShellMetacharacters: true }
      : {}),
  };

  for (const session of opts.plan.sessions) {
    // Session bootstrap: ensure we're on the intended page before any snapshots.
    // Many specs are pure assertions (no explicit navigation step), so without
    // this we end up snapshotting whatever page Chrome currently has open.
    if (
      typeof opts.targetUrl === "string" &&
      opts.targetUrl.trim() &&
      opts.capabilities.has(Capability.navigate) &&
      opts.integrations.chrome
    ) {
      const res = await runStep(
        {
          capability: Capability.navigate,
          action: "navigate_page",
          args: { url: opts.targetUrl },
        },
        baseCtx,
      );
      toolCalls.push(res.toolCall);
      artifacts.push(...res.artifacts);
    }

    const probes = session.probes;
    for (let pi = 0; pi < probes.length; pi++) {
      opts.abortSignal?.throwIfAborted();
      const probe = probes[pi];
      if (!probe) continue;
      const res = await runProbe(probe, {
        ...baseCtx,
        ...(typeof opts.stepRetries === "number"
          ? { stepRetries: opts.stepRetries }
          : {}),
        ...(typeof opts.stepRetryDelayMs === "number"
          ? { stepRetryDelayMs: opts.stepRetryDelayMs }
          : {}),
        ...(opts.allowShellMetacharacters === true
          ? { allowShellMetacharacters: true }
          : {}),
      });
      toolCalls.push(...res.toolCalls);
      artifacts.push(...res.artifacts);

      const more = pi < probes.length - 1;
      if (
        more &&
        opts.resetBetweenProbes !== false &&
        typeof opts.targetUrl === "string" &&
        opts.targetUrl.trim() &&
        opts.capabilities.has(Capability.navigate) &&
        opts.integrations.chrome
      ) {
        const nav = await runStep(
          {
            capability: Capability.navigate,
            action: "navigate_page",
            args: { url: opts.targetUrl },
          },
          baseCtx,
        );
        toolCalls.push(nav.toolCall);
        artifacts.push(...nav.artifacts);
      }
    }
  }

  return { toolCalls, artifacts };
}
