import { z } from "zod";

export const CapabilityNameSchema = z.enum([
  "navigate",
  "read_ui_structure",
  "read_visual",
  "interact",
  "read_console",
  "read_network",
  "read_files",
  "run_command",
  "call_http",
  "query_data_store",
  "read_source_code",
  "read_design_reference",
]);
export type CapabilityName = z.infer<typeof CapabilityNameSchema>;

/** All capability string ids (for policies, UI, and exhaustiveness checks). */
export const ALL_CAPABILITY_NAMES: readonly CapabilityName[] =
  CapabilityNameSchema.options;

export type CapabilitySet = Set<CapabilityName>;
