import { randomUUID } from "node:crypto";
import { Capability } from "../../capabilities/types.js";
import { EXPECTED_CHROME_DEVTOOLS_TOOLS } from "../../integrations/chromeDevtools/expectedTools.js";
import { ChromeDevtoolsMcpIntegration } from "../../integrations/chromeDevtools/chromeDevtoolsMcpIntegration.js";
import { McpToolClient } from "../../mcp/client.js";
import { DART_MCP_TOOL_NAMES } from "../../mcp/dartToolNames.js";
import type { McpServerConfig } from "../../mcp/types.js";
import { DEFAULT_BUTTON_STYLE_TOOL_CALL } from "../../planners/buttonStyleEvidence.js";
import type { ToolCallIR } from "../../planners/planIr.js";
import { extractMcpText, tryParseJsonFence } from "../mcpText.js";
import { withTimeout } from "../timeout.js";
import type {
  PluginActivateContext,
  PluginCreateContext,
  PluginExecuteContext,
  PluginHandle,
  ToolPlugin,
} from "../types.js";

const BROWSER_CAPABILITIES = new Set([
  "navigate",
  "read_ui_structure",
  "read_visual",
  "interact",
  "read_console",
  "read_network",
]);

function buildServerConfig(
  server: NonNullable<PluginCreateContext["chromeDevtoolsServer"]>,
): McpServerConfig {
  const serverCfg: McpServerConfig = {
    kind: "stdio",
    command: server.command,
  };
  if (server.args) {
    const args = server.args.slice();
    if (!args.includes("--isolated")) args.push("--isolated");
    serverCfg.args = args;
  }
  if (server.cwd) serverCfg.cwd = server.cwd;
  if (server.env) serverCfg.env = server.env;
  return serverCfg;
}

export const chromeDevtoolsPlugin: ToolPlugin = {
  id: "chrome-devtools",
  capabilities: [
    Capability.navigate,
    Capability.read_ui_structure,
    Capability.read_visual,
    Capability.interact,
    Capability.read_console,
    Capability.read_network,
  ],
  isMcpHost: true,
  async createHandle(ctx: PluginCreateContext): Promise<PluginHandle | null> {
    if (!ctx.chromeDevtoolsServer?.command) return null;
    const chrome = new ChromeDevtoolsMcpIntegration({
      server: buildServerConfig(ctx.chromeDevtoolsServer),
    });
    return {
      id: "chrome-devtools",
      isMcpHost: true,
      contributions: { chrome },
      async activate(activateCtx: PluginActivateContext) {
        const toolCallId = randomUUID();
        const startedAt = new Date().toISOString();
        activateCtx.publish({
          type: "step_started",
          runId: activateCtx.runId,
          toolCallId,
          capability: "preflight",
          action: "init_chrome_devtools",
          startedAt,
          args: { command: ctx.chromeDevtoolsServer?.command ?? null },
        });
        activateCtx.publish({
          type: "step_finished",
          runId: activateCtx.runId,
          toolCallId,
          capability: "preflight",
          action: "init_chrome_devtools",
          startedAt,
          endedAt: new Date().toISOString(),
          ok: true,
        });
      },
      async listTools() {
        return await chrome.listTools();
      },
      async close() {
        await chrome.close();
      },
      canExecute(step: ToolCallIR) {
        if (DART_MCP_TOOL_NAMES.has(step.tool)) return false;
        if (step.capability === "navigate") return true;
        return BROWSER_CAPABILITIES.has(step.capability);
      },
      async executeStep(step: ToolCallIR, execCtx: PluginExecuteContext) {
        if (step.capability === "navigate") {
          const url = String((step.args as Record<string, unknown>)?.url ?? "");
          await withTimeout(chrome.navigate(url), step.timeoutMs, "navigate");
          return { output: { ok: true, url } };
        }

        if (
          step.capability === "read_ui_structure" &&
          step.tool === "take_snapshot"
        ) {
          const { snapshot, artifact } = await withTimeout(
            chrome.takeSnapshot(execCtx.artifactStore),
            step.timeoutMs,
            "take_snapshot",
          );
          return {
            output: {
              snapshotText: snapshot.snapshotText,
              artifactId: artifact.id,
              ...(step.label ? { label: step.label } : {}),
            },
            artifacts: [artifact],
          };
        }

        if (
          step.capability === "read_visual" &&
          step.tool === "take_screenshot"
        ) {
          const artifact = await withTimeout(
            chrome.takeScreenshot(execCtx.artifactStore, step.label),
            step.timeoutMs,
            "take_screenshot",
          );
          return {
            output: {
              artifactId: artifact.id,
              ...(step.label ? { label: step.label } : {}),
            },
            artifacts: [artifact],
          };
        }

        const res = await withTimeout(
          chrome.call(step.tool, step.args ?? {}),
          step.timeoutMs,
          step.tool,
        );
        if (step.tool === "evaluate_script") {
          const responseText = extractMcpText(res);
          const parsed = tryParseJsonFence(responseText);
          return {
            output: {
              response: res,
              responseText,
              ...(parsed !== undefined ? { parsedJson: parsed } : {}),
            },
          };
        }
        return {
          output: {
            response: res,
            ...(step.label ? { label: step.label } : {}),
          },
        };
      },
      defaultPlanFallback(ctx) {
        return [
          {
            capability: "navigate",
            tool: "navigate_page",
            args: { url: ctx.targetUrl },
          },
          {
            capability: "read_ui_structure",
            tool: "take_snapshot",
            args: {},
          },
          {
            capability: "read_visual",
            tool: "take_screenshot",
            args: {},
            label: "dashboard",
          },
          DEFAULT_BUTTON_STYLE_TOOL_CALL,
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
    const tools = await chromeDevtoolsPlugin.listToolsFromServerConfig!(server);
    const names = new Set(tools.map((t) => t.name));
    const missing = EXPECTED_CHROME_DEVTOOLS_TOOLS.filter((n) => !names.has(n));
    const extra = [...names]
      .filter(
        (n) =>
          !EXPECTED_CHROME_DEVTOOLS_TOOLS.includes(
            n as (typeof EXPECTED_CHROME_DEVTOOLS_TOOLS)[number],
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
