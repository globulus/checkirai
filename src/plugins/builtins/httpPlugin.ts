import { Capability } from "../../capabilities/types.js";
import { createHttpIntegration } from "../../integrations/http/httpIntegration.js";
import type { ToolCallIR } from "../../planners/planIr.js";
import { withTimeout } from "../timeout.js";
import type {
  PluginCreateContext,
  PluginExecuteContext,
  PluginHandle,
  ToolPlugin,
} from "../types.js";

export const httpPlugin: ToolPlugin = {
  id: "http",
  capabilities: [Capability.call_http],
  async createHandle(_ctx: PluginCreateContext): Promise<PluginHandle> {
    const http = createHttpIntegration();
    return {
      id: "http",
      contributions: { http },
      canExecute(step: ToolCallIR) {
        return step.capability === "call_http";
      },
      async executeStep(step: ToolCallIR, _execCtx: PluginExecuteContext) {
        const url = String((step.args as Record<string, unknown>)?.url ?? "");
        const output = await withTimeout(
          http.get(url),
          step.timeoutMs,
          "http.get",
        );
        return { output };
      },
    };
  },
};
