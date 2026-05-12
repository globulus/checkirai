import { randomUUID } from "node:crypto";
import type { CapabilitySet } from "../capabilities/types.js";
import type { ExecutorIntegrations } from "../executors/integrations.js";
import type { McpToolDescriptor } from "../mcp/client.js";
import type { RunEventSink } from "../ops/events.js";
import type { ToolCallIR } from "../planners/planIr.js";
import { VerifierError } from "../shared/errors.js";
import { capabilitiesFromTools } from "./capabilities.js";
import { getPluginsForIds } from "./registry.js";
import {
  resolveEnabledPluginIds,
  toolSetHas,
} from "./resolveEnabledPlugins.js";
import type {
  PluginCreateContext,
  PluginExecuteContext,
  PluginHandle,
  PluginStepResult,
} from "./types.js";

export type IntegrationRuntimeInput = {
  tools?: string | undefined;
  runId: string;
  publish: RunEventSink;
  chromeDevtoolsServer?: PluginCreateContext["chromeDevtoolsServer"];
  dartMcpServer?: PluginCreateContext["dartMcpServer"];
  dartProjectRoot?: string;
  dartDriverDevice?: string;
  shellAllowCommands?: string[];
};

function publishPreflightFailure(opts: {
  publish: RunEventSink;
  runId: string;
  action: string;
  args: Record<string, unknown>;
  errorMessage: string;
}) {
  const startedAt = new Date().toISOString();
  const toolCallId = randomUUID();
  opts.publish({
    type: "step_started",
    runId: opts.runId,
    toolCallId,
    capability: "preflight",
    action: opts.action,
    startedAt,
    args: opts.args,
  });
  opts.publish({
    type: "step_finished",
    runId: opts.runId,
    toolCallId,
    capability: "preflight",
    action: opts.action,
    startedAt,
    endedAt: new Date().toISOString(),
    ok: false,
    errorMessage: opts.errorMessage,
  });
}

export class IntegrationRuntime {
  readonly capabilities: CapabilitySet;
  private readonly handles: PluginHandle[] = [];
  private readonly enabledPluginIds: string[];
  private readonly integrations: ExecutorIntegrations;

  private constructor(opts: {
    capabilities: CapabilitySet;
    handles: PluginHandle[];
    enabledPluginIds: string[];
    integrations: ExecutorIntegrations;
  }) {
    this.capabilities = opts.capabilities;
    this.handles = opts.handles;
    this.enabledPluginIds = opts.enabledPluginIds;
    this.integrations = opts.integrations;
  }

  static async create(
    input: IntegrationRuntimeInput,
  ): Promise<IntegrationRuntime> {
    const enabledPluginIds = resolveEnabledPluginIds(input.tools);
    const capabilities = capabilitiesFromTools(input.tools);
    const createCtx: PluginCreateContext = {
      runId: input.runId,
      publish: input.publish,
      ...(input.chromeDevtoolsServer
        ? { chromeDevtoolsServer: input.chromeDevtoolsServer }
        : {}),
      ...(input.dartMcpServer ? { dartMcpServer: input.dartMcpServer } : {}),
      ...(input.dartProjectRoot
        ? { dartProjectRoot: input.dartProjectRoot }
        : {}),
      ...(input.dartDriverDevice
        ? { dartDriverDevice: input.dartDriverDevice }
        : {}),
      ...(input.shellAllowCommands
        ? { shellAllowCommands: input.shellAllowCommands }
        : {}),
    };

    if (
      toolSetHas(input.tools, "chrome-devtools") &&
      !input.chromeDevtoolsServer?.command
    ) {
      const errorMessage =
        "chrome-devtools requested but chromeDevtoolsServer config missing (command/args/cwd).";
      publishPreflightFailure({
        publish: input.publish,
        runId: input.runId,
        action: "init_chrome_devtools",
        args: { command: null },
        errorMessage,
      });
      throw new Error(errorMessage);
    }
    if (toolSetHas(input.tools, "dart-mcp") && !input.dartMcpServer?.command) {
      const errorMessage =
        "dart-mcp requested but dartMcpServer config missing (command/args/cwd).";
      publishPreflightFailure({
        publish: input.publish,
        runId: input.runId,
        action: "init_dart_mcp",
        args: { command: null },
        errorMessage,
      });
      throw new Error(errorMessage);
    }

    const handles: PluginHandle[] = [];
    const integrations: ExecutorIntegrations = {};
    for (const plugin of getPluginsForIds(enabledPluginIds)) {
      const handle = await plugin.createHandle(createCtx);
      if (!handle) continue;
      handles.push(handle);
      if (handle.contributions) {
        Object.assign(integrations, handle.contributions);
      }
    }

    return new IntegrationRuntime({
      capabilities,
      handles,
      enabledPluginIds,
      integrations,
    });
  }

  async activateAll(ctx: {
    runId: string;
    publish: RunEventSink;
  }): Promise<void> {
    for (const handle of this.handles) {
      if (!handle.activate) continue;
      await handle.activate(ctx);
    }
  }

  hasMcpToolHost(): boolean {
    return this.handles.some((handle) => handle.isMcpHost);
  }

  async listMcpTools(): Promise<McpToolDescriptor[]> {
    const out: McpToolDescriptor[] = [];
    for (const handle of this.handles) {
      if (!handle.listTools) continue;
      out.push(...(await handle.listTools()));
    }
    return out;
  }

  defaultToolPlanFallback(ctx: {
    targetUrl: string;
    dartProjectRoot?: string;
  }): ToolCallIR[] {
    const hasChrome = this.handles.some(
      (handle) => handle.id === "chrome-devtools",
    );
    for (const handle of this.handles) {
      if (
        handle.id === "dart-mcp" &&
        hasChrome &&
        handle.defaultPlanFallback?.(ctx)?.length
      ) {
        continue;
      }
      const plan = handle.defaultPlanFallback?.(ctx);
      if (plan?.length) return plan;
    }
    return [];
  }

  plannerHints(): string[] {
    const hints: string[] = [];
    for (const pluginId of this.enabledPluginIds) {
      const plugin = getPluginsForIds([pluginId])[0];
      if (plugin?.plannerHints?.length) hints.push(...plugin.plannerHints);
    }
    return hints;
  }

  findExecutor(step: ToolCallIR): PluginHandle | undefined {
    return this.handles.find((handle) => handle.canExecute(step));
  }

  async executeStep(
    step: ToolCallIR,
    ctx: PluginExecuteContext,
  ): Promise<PluginStepResult> {
    const handle = this.findExecutor(step);
    if (!handle) {
      throw new VerifierError(
        "TOOL_UNAVAILABLE",
        `No plugin available for capability ${step.capability} / tool ${step.tool}`,
      );
    }
    return await handle.executeStep(step, ctx);
  }

  async closeAll(): Promise<void> {
    for (const handle of this.handles) {
      if (!handle.close) continue;
      try {
        await handle.close();
      } catch {
        // ignore best-effort cleanup
      }
    }
  }

  toExecutorIntegrations(): ExecutorIntegrations {
    return this.integrations;
  }
}
