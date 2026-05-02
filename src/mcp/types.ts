export type McpStdioServerConfig = {
  kind: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig;
