import { Capability } from "../../capabilities/types.js";
import { createShellIntegration } from "../../integrations/shell/shellIntegration.js";
import type { ToolCallIR } from "../../planners/planIr.js";
import type {
  PluginCreateContext,
  PluginExecuteContext,
  PluginHandle,
  ToolPlugin,
} from "../types.js";

export const shellPlugin: ToolPlugin = {
  id: "shell",
  capabilities: [Capability.run_command],
  async createHandle(ctx: PluginCreateContext): Promise<PluginHandle> {
    const shell = createShellIntegration({
      allowCommands: ctx.shellAllowCommands ?? [],
    });
    return {
      id: "shell",
      contributions: { shell },
      canExecute(step: ToolCallIR) {
        return step.capability === "run_command" && step.tool !== "pub";
      },
      async executeStep(step: ToolCallIR, _execCtx: PluginExecuteContext) {
        const args = step.args as Record<string, unknown>;
        const command = String(args.command ?? "");
        const commandArgs = Array.isArray(args.args)
          ? args.args.map((a) => String(a))
          : [];
        const output = await shell.run(command, commandArgs, {
          ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
          ...(typeof step.timeoutMs === "number"
            ? { timeoutMs: step.timeoutMs }
            : {}),
        });
        return { output };
      },
    };
  },
};
