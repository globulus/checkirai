import type { CapabilityName, CapabilitySet } from "../capabilities/types.js";
import { getPluginById } from "./registry.js";
import { resolveEnabledPluginIds } from "./resolveEnabledPlugins.js";

export function capabilitiesForPluginIds(pluginIds: string[]): CapabilitySet {
  const capabilities = new Set<CapabilityName>();
  for (const pluginId of pluginIds) {
    const plugin = getPluginById(pluginId);
    if (!plugin) continue;
    for (const capability of plugin.capabilities) {
      capabilities.add(capability);
    }
  }
  return capabilities;
}

export function capabilitiesFromTools(tools?: string): CapabilitySet {
  return capabilitiesForPluginIds(resolveEnabledPluginIds(tools));
}
