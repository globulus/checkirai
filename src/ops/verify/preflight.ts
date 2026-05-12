import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { checkOllamaRunning } from "../../llm/modelOps.js";
import { ollamaModelsFromPolicy, policyUsesOllama } from "../../llm/types.js";
import { IntegrationRuntime } from "../../plugins/runtime.js";
import { toolSetHas } from "../../plugins/resolveEnabledPlugins.js";
import { VerifierError } from "../../shared/errors.js";
import { nowIso } from "./artifacts.js";
import type { VerifyRunContext } from "./context.js";

export type PreflightResult = {
  integrationRuntime: IntegrationRuntime;
  integrations: ReturnType<IntegrationRuntime["toExecutorIntegrations"]>;
};

export async function runPreflight(
  run: VerifyRunContext,
): Promise<PreflightResult> {
  if (policyUsesOllama(run.llmPolicy)) {
    const toolCallId = randomUUID();
    const startedAtIso = nowIso();
    run.publish({
      type: "step_started",
      runId: run.runId,
      toolCallId,
      capability: "preflight",
      action: "check_ollama",
      startedAt: startedAtIso,
      args: {
        host: run.llmPolicy.ollamaHost,
        models: ollamaModelsFromPolicy(run.llmPolicy),
      },
    });
    const status = await checkOllamaRunning(run.llmPolicy.ollamaHost);
    run.publish({
      type: "step_finished",
      runId: run.runId,
      toolCallId,
      capability: "preflight",
      action: "check_ollama",
      startedAt: startedAtIso,
      endedAt: nowIso(),
      ok: status.ok,
      result: status,
      ...(status.ok
        ? {}
        : { errorMessage: status.error?.message ?? "Ollama not running" }),
    });
    if (!status.ok) {
      throw new Error(status.error?.message ?? "Ollama not running");
    }
  }

  const dartProjectRoot =
    run.input.dartProjectRoot?.trim() ||
    run.projectCfg?.defaults?.dartProjectRoot?.trim() ||
    undefined;
  run.dartProjectRoot = dartProjectRoot;

  const integrationRuntime = await IntegrationRuntime.create({
    runId: run.runId,
    publish: run.publish,
    tools: run.input.tools,
    ...(run.input.chromeDevtoolsServer
      ? { chromeDevtoolsServer: run.input.chromeDevtoolsServer }
      : {}),
    ...(run.input.dartMcpServer
      ? { dartMcpServer: run.input.dartMcpServer }
      : {}),
    ...(dartProjectRoot ? { dartProjectRoot } : {}),
    ...(run.input.dartDriverDevice?.trim()
      ? { dartDriverDevice: run.input.dartDriverDevice.trim() }
      : {}),
  });
  const integrations = integrationRuntime.toExecutorIntegrations();

  if (toolSetHas(run.input.tools, "http")) {
    if (!integrations.http) {
      throw new VerifierError(
        "TOOL_UNAVAILABLE",
        "HTTP integration not configured.",
      );
    }
    const http = integrations.http;
    if (run.input.launchCommand?.trim()) {
      run.launchChild.current = spawn(run.input.launchCommand.trim(), {
        shell: true,
        cwd: run.input.launchCwd?.trim() || undefined,
        stdio: "ignore",
      });
    }

    const toolCallId = randomUUID();
    const startedAtIso = nowIso();
    run.publish({
      type: "step_started",
      runId: run.runId,
      toolCallId,
      capability: "preflight",
      action: "check_target_url",
      startedAt: startedAtIso,
      args: {
        url: run.input.targetUrl,
        ...(run.input.launchCommand?.trim()
          ? { launchCommand: run.input.launchCommand.trim() }
          : {}),
      },
    });
    try {
      const maxWaitMs = run.input.launchCommand?.trim()
        ? (run.input.launchReadyTimeoutMs ?? 30_000)
        : 15_000;
      const deadline = Date.now() + maxWaitMs;
      let res: Awaited<ReturnType<typeof http.get>> | undefined;
      while (Date.now() < deadline) {
        run.runAbortSignal?.throwIfAborted();
        try {
          const attempt = await http.get(run.input.targetUrl, {
            headers: { range: "bytes=0-200" },
          });
          if (attempt.status < 500) {
            res = attempt;
            break;
          }
        } catch {
          // keep polling when launchCommand is warming up
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!res) {
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Target URL did not become reachable within ${maxWaitMs}ms: ${run.input.targetUrl}`,
        );
      }
      if (res.status >= 500) {
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Target URL responded with ${res.status}: ${run.input.targetUrl}`,
          { details: { status: res.status } },
        );
      }
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId,
        capability: "preflight",
        action: "check_target_url",
        startedAt: startedAtIso,
        endedAt: nowIso(),
        ok: true,
        result: { status: res.status },
      });
    } catch (e) {
      run.publish({
        type: "step_finished",
        runId: run.runId,
        toolCallId,
        capability: "preflight",
        action: "check_target_url",
        startedAt: startedAtIso,
        endedAt: nowIso(),
        ok: false,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      if (run.launchChild.current && !run.launchChild.current.killed) {
        try {
          run.launchChild.current.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      throw new VerifierError(
        "TOOL_UNAVAILABLE",
        `Target URL is not reachable: ${run.input.targetUrl}`,
        { cause: e },
      );
    }
  } else if (run.input.launchCommand?.trim()) {
    throw new Error(
      "launchCommand is set but tools do not include 'http' (needed to poll target readiness).",
    );
  }

  await integrationRuntime.activateAll({
    runId: run.runId,
    publish: run.publish,
  });

  return { integrationRuntime, integrations };
}
