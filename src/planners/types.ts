import { z } from "zod";
import { CapabilityNameSchema } from "../capabilities/types.js";

export { CapabilityNameSchema };
export type CapabilityName = z.infer<typeof CapabilityNameSchema>;

export const SideEffectsSchema = z.enum(["none", "ui_only", "data_mutation"]);
export type SideEffects = z.infer<typeof SideEffectsSchema>;

export const ProbeStepSchema = z.object({
  capability: CapabilityNameSchema,
  action: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  evidence: z
    .object({
      capture: z.array(z.string()).default([]),
    })
    .optional(),
});
export type ProbeStep = z.infer<typeof ProbeStepSchema>;

export const ProbeSchema = z.object({
  id: z.string(),
  requirementId: z.string(),
  capabilityNeeds: z.array(CapabilityNameSchema).default([]),
  steps: z.array(ProbeStepSchema).default([]),
  sideEffects: SideEffectsSchema.default("none"),
  costHint: z.number().int().nonnegative().default(0),
  strategy: z.string().optional(),
});
export type Probe = z.infer<typeof ProbeSchema>;

export const ProbePlanSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      probes: z.array(ProbeSchema).default([]),
      hints: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
export type ProbePlan = z.infer<typeof ProbePlanSchema>;
