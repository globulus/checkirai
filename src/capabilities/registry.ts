import type { CapabilitySet } from "./types.js";
import {
  capabilitiesForPluginIds,
  capabilitiesFromTools,
} from "../plugins/capabilities.js";

export type IntegrationConfig = {
  enable: {
    playwrightMcp?: boolean;
    dartMcp?: boolean;
    shell?: boolean;
    fs?: boolean;
    http?: boolean;
  };
};

export type CapabilityGraph = {
  capabilities: CapabilitySet;
};

export function buildCapabilityGraph(cfg: IntegrationConfig): CapabilityGraph {
  const pluginIds: string[] = [];
  if (cfg.enable.fs) pluginIds.push("fs");
  if (cfg.enable.http) pluginIds.push("http");
  if (cfg.enable.shell) pluginIds.push("shell");
  if (cfg.enable.dartMcp) pluginIds.push("dart-mcp");
  if (cfg.enable.playwrightMcp) pluginIds.push("playwright-mcp");
  return { capabilities: capabilitiesForPluginIds(pluginIds) };
}

export function buildCapabilityGraphFromTools(tools?: string): CapabilityGraph {
  return { capabilities: capabilitiesFromTools(tools) };
}
