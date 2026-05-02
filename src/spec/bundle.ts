import { z } from "zod";

export const SpecInputItemSchema = z.object({
  kind: z.enum(["markdown", "url", "file"]),
  ref: z.string(),
  notes: z.string().optional(),
});
export type SpecInputItem = z.infer<typeof SpecInputItemSchema>;

export const SpecBundleSchema = z.object({
  run_goal: z.string().optional(),
  inputs: z.array(SpecInputItemSchema).min(1),
  // Optional hints to constrain what integrations are allowed to read inputs.
  allowedCapabilities: z.array(z.string()).optional(),
});
export type SpecBundle = z.infer<typeof SpecBundleSchema>;
