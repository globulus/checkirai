import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./types.js";

export type ToolCallResponse = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export class McpToolClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private connected = false;

  constructor(cfg: McpServerConfig) {
    this.client = new Client(
      { name: "checkirai", version: "0.1.0" },
      { capabilities: {} },
    );
    const params: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    } = {
      command: cfg.command,
    };
    if (cfg.args) params.args = cfg.args;
    if (cfg.cwd) params.cwd = cfg.cwd;
    if (cfg.env) params.env = cfg.env;
    this.transport = new StdioClientTransport(params);
  }

  async connect() {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async close() {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    await this.connect();
    const res = await this.client.listTools({});
    return res.tools.map((t) => {
      const out: McpToolDescriptor = { name: t.name };
      if (t.description) out.description = t.description;
      // MCP spec includes JSON schema for tool input.
      // We pass it through so the planner can generate valid arguments.
      if ("inputSchema" in t)
        out.inputSchema = (t as { inputSchema?: unknown }).inputSchema;
      return out;
    });
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResponse> {
    await this.connect();
    const res = await this.client.callTool({ name: toolName, arguments: args });
    // SDK returns CallToolResult with `content` and optional `structuredContent`.
    return res as unknown as ToolCallResponse;
  }
}
