import { randomUUID } from "node:crypto";
import { Capability } from "../../capabilities/types.js";
import { EXPECTED_DART_MCP_TOOLS } from "../../integrations/dart/expectedTools.js";
import { DartMcpIntegration } from "../../integrations/dart/dartMcpIntegration.js";
import { DART_MCP_TOOL_NAMES } from "../../mcp/dartToolNames.js";
import { McpToolClient } from "../../mcp/client.js";
import type { McpServerConfig } from "../../mcp/types.js";
import type { ToolCallIR } from "../../planners/planIr.js";
import { extractMcpText } from "../mcpText.js";
import { withTimeout } from "../timeout.js";
import type {
  PluginActivateContext,
  PluginCreateContext,
  PluginExecuteContext,
  PluginHandle,
  ToolPlugin,
} from "../types.js";

const ROOT_SCOPED_TOOLS = new Set([
  "get_widget_tree",
  "run_tests",
  "analyze_files",
]);

function buildServerConfig(
  server: NonNullable<PluginCreateContext["dartMcpServer"]>,
): McpServerConfig {
  return {
    kind: "stdio",
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.env ? { env: server.env } : {}),
  };
}

function isDartOwnedStep(step: ToolCallIR): boolean {
  if (DART_MCP_TOOL_NAMES.has(step.tool)) return true;
  if (step.capability === "run_automated_tests") return true;
  if (step.capability === "read_flutter_runtime") return true;
  if (step.capability === "run_command" && step.tool === "pub") return true;
  if (step.capability === "read_files" && step.tool === "analyze_files") {
    return true;
  }
  return false;
}

export const dartMcpPlugin: ToolPlugin = {
  id: "dart-mcp",
  capabilities: [
    Capability.run_automated_tests,
    Capability.read_flutter_runtime,
    Capability.read_ui_structure,
    Capability.interact,
    Capability.read_files,
    Capability.run_command,
  ],
  isMcpHost: true,
  plannerHints: [
    "For Flutter/Dart tools: pass project roots as file: URIs in roots[].root; call get_widget_tree before inventing flutter_driver finders; prefer run_tests when requirements are covered by automated tests.",
  ],
  async createHandle(ctx: PluginCreateContext): Promise<PluginHandle | null> {
    if (!ctx.dartMcpServer?.command) return null;
    const dart = new DartMcpIntegration({
      server: buildServerConfig(ctx.dartMcpServer),
      ...(ctx.dartProjectRoot ? { projectRoot: ctx.dartProjectRoot } : {}),
    });
    return {
      id: "dart-mcp",
      isMcpHost: true,
      contributions: { dart },
      async activate(activateCtx: PluginActivateContext) {
        const toolCallId = randomUUID();
        const startedAt = new Date().toISOString();
        activateCtx.publish({
          type: "step_started",
          runId: activateCtx.runId,
          toolCallId,
          capability: "preflight",
          action: "init_dart_mcp",
          startedAt,
          args: { command: ctx.dartMcpServer?.command ?? null },
        });
        if (ctx.dartProjectRoot) {
          await dart.ensureRoot(ctx.dartProjectRoot);
        }
        if (ctx.dartDriverDevice?.trim()) {
          const device = ctx.dartDriverDevice.trim();
          const launch = await dart.launchApp({
            root: ctx.dartProjectRoot ?? "",
            device,
          });
          const dtdUri =
            "dtdUri" in launch && typeof launch.dtdUri === "string"
              ? launch.dtdUri
              : undefined;
          if (dtdUri) {
            await dart.connectDtd(dtdUri);
          }
        }
        activateCtx.publish({
          type: "step_finished",
          runId: activateCtx.runId,
          toolCallId,
          capability: "preflight",
          action: "init_dart_mcp",
          startedAt,
          endedAt: new Date().toISOString(),
          ok: true,
        });
      },
      async listTools() {
        return await dart.listTools();
      },
      async close() {
        await dart.close();
      },
      canExecute(step: ToolCallIR) {
        return isDartOwnedStep(step);
      },
      async executeStep(step: ToolCallIR, execCtx: PluginExecuteContext) {
        execCtx.abortSignal?.throwIfAborted();
        const args = { ...(step.args ?? {}) };
        if (ROOT_SCOPED_TOOLS.has(step.tool)) {
          await dart.ensureRoot();
        } else if (
          step.capability === "run_automated_tests" ||
          (step.capability === "run_command" && step.tool === "pub")
        ) {
          await dart.ensureRoot();
        }
        const res = await withTimeout(
          dart.call(step.tool, args),
          step.timeoutMs,
          step.tool,
        );
        return {
          output: {
            response: res,
            responseText: extractMcpText(res),
            ...(step.label ? { label: step.label } : {}),
          },
        };
      },
      defaultPlanFallback(ctx) {
        if (!ctx.dartProjectRoot) return undefined;
        return [
          {
            capability: "run_automated_tests",
            tool: "run_tests",
            args: {
              roots: [{ root: ctx.dartProjectRoot, paths: ["test"] }],
            },
          },
          {
            capability: "read_files",
            tool: "analyze_files",
            args: { roots: [{ root: ctx.dartProjectRoot }] },
          },
        ];
      },
    };
  },
  async listToolsFromServerConfig(server) {
    const client = new McpToolClient(server);
    const tools = await client.listTools();
    await client.close();
    return tools;
  },
  async selfCheck(server) {
    const tools = await dartMcpPlugin.listToolsFromServerConfig!(server);
    const names = new Set(tools.map((t) => t.name));
    const missing = EXPECTED_DART_MCP_TOOLS.filter((n) => !names.has(n));
    const extra = [...names]
      .filter(
        (n) =>
          !EXPECTED_DART_MCP_TOOLS.includes(
            n as (typeof EXPECTED_DART_MCP_TOOLS)[number],
          ),
      )
      .sort();
    return {
      ok: missing.length === 0,
      missing: [...missing],
      extra,
      count: tools.length,
    };
  },
};
