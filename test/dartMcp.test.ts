import { describe, expect, it } from "vitest";
import { buildCapabilityGraph } from "../src/capabilities/registry.js";
import { DART_MCP_TOOL_NAMES } from "../src/mcp/dartToolNames.js";
import { dartMcpPlugin } from "../src/plugins/builtins/dartMcpPlugin.js";
import { IntegrationRuntime } from "../src/plugins/runtime.js";
import { resolveEnabledPluginIds } from "../src/plugins/resolveEnabledPlugins.js";

describe("dart-mcp capability graph", () => {
  it("enables Flutter capabilities when dart-mcp is enabled", () => {
    const graph = buildCapabilityGraph({
      enable: { dartMcp: true },
    });
    expect(graph.capabilities.has("run_automated_tests")).toBe(true);
    expect(graph.capabilities.has("read_flutter_runtime")).toBe(true);
    expect(graph.capabilities.has("read_ui_structure")).toBe(true);
    expect(graph.capabilities.has("interact")).toBe(true);
  });
});

describe("dart MCP plugin routing", () => {
  it("classifies known Dart MCP tool names", () => {
    expect(DART_MCP_TOOL_NAMES.has("run_tests")).toBe(true);
    expect(DART_MCP_TOOL_NAMES.has("flutter_driver")).toBe(true);
    expect(DART_MCP_TOOL_NAMES.has("take_snapshot")).toBe(false);
  });

  it("detects MCP tool hosts on executor integrations", async () => {
    const runtime = await IntegrationRuntime.create({
      runId: "test",
      publish: () => {},
      tools: "dart-mcp",
      dartMcpServer: { command: "true" },
    });
    expect(runtime.hasMcpToolHost()).toBe(true);
    await runtime.closeAll();
  });

  it("builds a Dart-first empty plan fallback when chrome is absent", async () => {
    const root = "file:///tmp/flutter_app";
    const runtime = await IntegrationRuntime.create({
      runId: "test",
      publish: () => {},
      tools: "dart-mcp",
      dartMcpServer: { command: "true" },
      dartProjectRoot: root,
    });
    const plan = runtime.defaultToolPlanFallback({
      targetUrl: "http://example.test",
      dartProjectRoot: root,
    });
    expect(plan[0]?.tool).toBe("run_tests");
    expect(plan[0]?.capability).toBe("run_automated_tests");
    expect(plan[1]?.tool).toBe("analyze_files");
    await runtime.closeAll();
  });

  it("prefers chrome fallback when both hosts are enabled", async () => {
    const root = "file:///tmp/flutter_app";
    const runtime = await IntegrationRuntime.create({
      runId: "test",
      publish: () => {},
      tools: "dart-mcp,chrome-devtools",
      dartMcpServer: { command: "true" },
      chromeDevtoolsServer: { command: "true" },
      dartProjectRoot: root,
    });
    const plan = runtime.defaultToolPlanFallback({
      targetUrl: "http://example.test",
      dartProjectRoot: root,
    });
    expect(plan[0]?.tool).toBe("navigate_page");
    await runtime.closeAll();
  });

  it("resolves plugin ids from tool tokens", () => {
    expect(resolveEnabledPluginIds("fs,http,dart-mcp,playwright-mcp")).toEqual([
      "fs",
      "http",
      "dart-mcp",
      "playwright-mcp",
    ]);
  });

  it("routes overlapping UI tools to dart before chrome", async () => {
    const runtime = await IntegrationRuntime.create({
      runId: "test",
      publish: () => {},
      tools: "dart-mcp,chrome-devtools",
      dartMcpServer: { command: "true" },
      chromeDevtoolsServer: { command: "true" },
    });
    const step = {
      capability: "read_ui_structure" as const,
      tool: "get_widget_tree",
      args: {},
    };
    const handle = runtime.findExecutor(step);
    expect(handle?.id).toBe("dart-mcp");
    expect(dartMcpPlugin.capabilities).toContain("read_ui_structure");
    await runtime.closeAll();
  });
});
