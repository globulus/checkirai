import type { OpsContext } from "./context.js";
import { chromeDevtoolsPlugin } from "../plugins/builtins/chromeDevtoolsPlugin.js";

export async function chromeDevtoolsListTools(
  _ctx: OpsContext,
  input: { command: string; args?: string[]; cwd?: string },
) {
  const tools = await chromeDevtoolsPlugin.listToolsFromServerConfig!({
    kind: "stdio",
    command: input.command,
    args: input.args ?? [],
    cwd: input.cwd ?? process.cwd(),
  });
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  };
}

export async function chromeDevtoolsSelfCheck(
  _ctx: OpsContext,
  input: { command: string; args?: string[]; cwd?: string },
) {
  return await chromeDevtoolsPlugin.selfCheck!({
    kind: "stdio",
    command: input.command,
    args: input.args ?? [],
    cwd: input.cwd ?? process.cwd(),
  });
}
