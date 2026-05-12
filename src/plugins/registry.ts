import { chromeDevtoolsPlugin } from "./builtins/chromeDevtoolsPlugin.js";
import { dartMcpPlugin } from "./builtins/dartMcpPlugin.js";
import { fsPlugin } from "./builtins/fsPlugin.js";
import { httpPlugin } from "./builtins/httpPlugin.js";
import { playwrightMcpPlugin } from "./builtins/playwrightMcpPlugin.js";
import { shellPlugin } from "./builtins/shellPlugin.js";
import type { ToolPlugin } from "./types.js";

export const BUILTIN_PLUGINS: readonly ToolPlugin[] = [
  fsPlugin,
  httpPlugin,
  shellPlugin,
  dartMcpPlugin,
  chromeDevtoolsPlugin,
  playwrightMcpPlugin,
];

const PLUGIN_BY_ID = new Map<string, ToolPlugin>(
  BUILTIN_PLUGINS.map((plugin) => [plugin.id, plugin]),
);

export function getPluginById(id: string): ToolPlugin | undefined {
  return PLUGIN_BY_ID.get(id);
}

export function getPluginsForIds(ids: string[]): ToolPlugin[] {
  return ids
    .map((id) => getPluginById(id))
    .filter((plugin): plugin is ToolPlugin => Boolean(plugin));
}
