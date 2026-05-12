import { Capability } from "../../capabilities/types.js";
import { createPlaywrightMcpIntegration } from "../../integrations/playwrightMcp/playwrightMcpIntegration.js";
import type { PluginCreateContext, ToolPlugin } from "../types.js";

export const playwrightMcpPlugin: ToolPlugin = {
  id: "playwright-mcp",
  capabilities: [
    Capability.navigate,
    Capability.read_ui_structure,
    Capability.read_visual,
    Capability.interact,
    Capability.read_console,
    Capability.read_network,
  ],
  async createHandle(_ctx: PluginCreateContext) {
    createPlaywrightMcpIntegration();
    return null;
  },
};
