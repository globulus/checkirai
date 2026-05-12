import { Capability } from "../../capabilities/types.js";
import { createFsIntegration } from "../../integrations/fs/fsIntegration.js";
import type { ToolCallIR } from "../../planners/planIr.js";
import { withTimeout } from "../timeout.js";
import type {
  PluginCreateContext,
  PluginExecuteContext,
  PluginHandle,
  ToolPlugin,
} from "../types.js";

export const fsPlugin: ToolPlugin = {
  id: "fs",
  capabilities: [Capability.read_files, Capability.read_source_code],
  async createHandle(_ctx: PluginCreateContext): Promise<PluginHandle> {
    const fs = createFsIntegration();
    return {
      id: "fs",
      contributions: { fs },
      canExecute(step: ToolCallIR) {
        return (
          step.capability === "read_files" && step.tool !== "analyze_files"
        );
      },
      async executeStep(step: ToolCallIR, _execCtx: PluginExecuteContext) {
        const path = String((step.args as Record<string, unknown>)?.path ?? "");
        const output = await withTimeout(
          Promise.resolve({ path, text: fs.readText(path) }),
          step.timeoutMs,
          "fs.readText",
        );
        return { output };
      },
    };
  },
};
