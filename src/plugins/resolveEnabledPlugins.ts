import { BUILTIN_PLUGINS } from "./registry.js";

const PLUGIN_BY_TOKEN = new Map<string, string>();
for (const plugin of BUILTIN_PLUGINS) {
  PLUGIN_BY_TOKEN.set(plugin.id, plugin.id);
  for (const alias of plugin.aliases ?? []) {
    PLUGIN_BY_TOKEN.set(alias, plugin.id);
  }
}

export function parseToolTokens(tools?: string): string[] {
  return String(tools ?? "fs,http")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolveEnabledPluginIds(tools?: string): string[] {
  const enabled = new Set<string>();
  for (const token of parseToolTokens(tools)) {
    const pluginId = PLUGIN_BY_TOKEN.get(token);
    if (pluginId) enabled.add(pluginId);
  }
  return [...enabled];
}

export function toolSetHas(tools: string | undefined, token: string): boolean {
  return parseToolTokens(tools).includes(token);
}
