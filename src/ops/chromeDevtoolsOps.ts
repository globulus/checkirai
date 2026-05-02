import { EXPECTED_CHROME_DEVTOOLS_TOOLS } from "../integrations/chromeDevtools/expectedTools.js";
import { McpToolClient } from "../mcp/client.js";
import type { OpsContext } from "./context.js";

export async function chromeDevtoolsListTools(
  _ctx: OpsContext,
  input: { command: string; args?: string[]; cwd?: string },
) {
  const client = new McpToolClient({
    kind: "stdio",
    command: input.command,
    args: input.args ?? [],
    cwd: input.cwd ?? process.cwd(),
  });
  const tools = await client.listTools();
  await client.close();
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  };
}

export async function chromeDevtoolsSelfCheck(
  _ctx: OpsContext,
  input: { command: string; args?: string[]; cwd?: string },
) {
  const client = new McpToolClient({
    kind: "stdio",
    command: input.command,
    args: input.args ?? [],
    cwd: input.cwd ?? process.cwd(),
  });
  const tools = await client.listTools();
  await client.close();

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
  return { ok: missing.length === 0, missing, extra, count: tools.length };
}
