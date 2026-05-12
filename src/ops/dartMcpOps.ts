import type { OpsContext } from "./context.js";
import { dartMcpPlugin } from "../plugins/builtins/dartMcpPlugin.js";

export async function dartMcpListTools(
  _ctx: OpsContext,
  input: { command: string; args?: string[]; cwd?: string },
) {
  const tools = await dartMcpPlugin.listToolsFromServerConfig!({
    kind: "stdio",
    command: input.command,
    args: input.args ?? [],
    cwd: input.cwd ?? process.cwd(),
  });
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  };
}

export async function dartMcpSelfCheck(
  _ctx: OpsContext,
  input: { command: string; args?: string[]; cwd?: string },
) {
  return await dartMcpPlugin.selfCheck!({
    kind: "stdio",
    command: input.command,
    args: input.args ?? [],
    cwd: input.cwd ?? process.cwd(),
  });
}
