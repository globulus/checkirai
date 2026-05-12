import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactRef } from "../artifacts/types.js";
import type { CapabilityName } from "../capabilities/types.js";
import type { ExecutorIntegrations } from "../executors/integrations.js";
import type { McpToolDescriptor } from "../mcp/client.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { RunEventSink } from "../ops/events.js";
import type { ToolCallIR } from "../planners/planIr.js";

export type PluginActivateContext = {
  runId: string;
  publish: RunEventSink;
};

export type PluginExecuteContext = {
  artifactStore: ArtifactStore;
  runId: string;
  abortSignal?: AbortSignal;
};

export type PluginStepResult = {
  output: unknown;
  artifacts?: ArtifactRef[];
};

export type PluginHandle = {
  id: string;
  isMcpHost?: boolean;
  contributions?: Partial<ExecutorIntegrations>;
  activate?(ctx: PluginActivateContext): Promise<void>;
  listTools?(): Promise<McpToolDescriptor[]>;
  close?(): Promise<void>;
  canExecute(step: ToolCallIR): boolean;
  executeStep(
    step: ToolCallIR,
    ctx: PluginExecuteContext,
  ): Promise<PluginStepResult>;
  defaultPlanFallback?(ctx: {
    targetUrl: string;
    dartProjectRoot?: string;
  }): ToolCallIR[] | undefined;
};

export type PluginSelfCheckResult = {
  ok: boolean;
  missing: string[];
  extra: string[];
  count: number;
};

export type ToolPlugin = {
  id: string;
  aliases?: readonly string[];
  capabilities: readonly CapabilityName[];
  isMcpHost?: boolean;
  plannerHints?: readonly string[];
  createHandle(ctx: PluginCreateContext): Promise<PluginHandle | null>;
  listToolsFromServerConfig?(
    server: McpServerConfig,
  ): Promise<McpToolDescriptor[]>;
  selfCheck?(server: McpServerConfig): Promise<PluginSelfCheckResult>;
};

export type PluginCreateContext = {
  runId: string;
  publish: RunEventSink;
  chromeDevtoolsServer?: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  dartMcpServer?: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  dartProjectRoot?: string;
  dartDriverDevice?: string;
  shellAllowCommands?: string[];
};
