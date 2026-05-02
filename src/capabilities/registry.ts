import type { CapabilityName, CapabilitySet } from "./types.js";

export type IntegrationConfig = {
  enable: {
    playwrightMcp?: boolean;
    shell?: boolean;
    fs?: boolean;
    http?: boolean;
  };
};

export type CapabilityGraph = {
  capabilities: CapabilitySet;
  // MVP: integrations are registered separately; graph currently only exposes availability.
};

export function buildCapabilityGraph(cfg: IntegrationConfig): CapabilityGraph {
  const capabilities = new Set<CapabilityName>();

  if (cfg.enable.playwrightMcp) {
    capabilities.add("navigate");
    capabilities.add("read_ui_structure");
    capabilities.add("read_visual");
    capabilities.add("interact");
    capabilities.add("read_console");
    capabilities.add("read_network");
  }

  if (cfg.enable.fs) {
    capabilities.add("read_files");
    capabilities.add("read_source_code");
  }

  if (cfg.enable.shell) {
    capabilities.add("run_command");
  }

  if (cfg.enable.http) {
    capabilities.add("call_http");
  }

  return { capabilities };
}
