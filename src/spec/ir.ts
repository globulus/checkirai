import { z } from "zod";

export const RequirementTypeSchema = z.enum([
  "structure",
  "navigation",
  "form",
  "persistence",
  "visible_state",
  "appearance",
  "accessibility",
  "integration",
]);
export type RequirementType = z.infer<typeof RequirementTypeSchema>;

export const RequirementPrioritySchema = z.enum(["must", "should", "could"]);
export type RequirementPriority = z.infer<typeof RequirementPrioritySchema>;

export const StepSchema = z.object({
  kind: z
    .enum([
      "navigate",
      "click",
      "type",
      "fill",
      "press",
      "wait",
      "assert",
      /**
       * Direct MCP tool call (evidence collection / special interactions).
       * Used by the LLM planner to request specific tool invocations with arguments
       * validated against the MCP tool surface.
       */
      "tool_call",
    ])
    .default("assert"),
  selector: z.string().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  ms: z.number().int().positive().optional(),
  tool: z.string().optional(),
  toolArgs: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().optional(),
});
export type StepIR = z.infer<typeof StepSchema>;

export const ObservableExpectationSchema = z.object({
  kind: z.enum([
    "text_present",
    "role_present",
    "url_matches",
    "element_visible",
    "element_enabled",
    "time_present",
    "toast_present",
    "network_request",
    "http_response",
    "file_contains",
  ]),
  selector: z.string().optional(),
  role: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  pattern: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ObservableExpectationIR = z.infer<
  typeof ObservableExpectationSchema
>;

export const ExpectedObservablesSetSchema = z.object({
  generic: z.array(ObservableExpectationSchema).default([]),
  detailed: z.array(ObservableExpectationSchema).default([]),
});
export type ExpectedObservablesSet = z.infer<
  typeof ExpectedObservablesSetSchema
>;

export const RequirementIRSchema = z.object({
  id: z.string(),
  source_text: z.string(),
  type: RequirementTypeSchema,
  priority: RequirementPrioritySchema.default("must"),
  preconditions: z.array(StepSchema).optional(),
  actions: z.array(StepSchema).optional(),
  expected_observables: z.array(ObservableExpectationSchema).default([]),
  /**
   * Optional dual encoding: keep both stable (generic) and precise (detailed)
   * expectation sets. The engine can choose which to evaluate via
   * SpecIR.acceptance_policy.observable_detail.
   */
  expected_observables_sets: ExpectedObservablesSetSchema.optional(),
  allowed_tolerance: z.record(z.string(), z.unknown()).optional(),
  verification_strategy: z.string().optional(),
  notes: z.string().optional(),
});
export type RequirementIR = z.infer<typeof RequirementIRSchema>;

export const SpecIRSchema = z.object({
  run_goal: z.string().default("Verify implementation against spec."),
  requirements: z.array(RequirementIRSchema).default([]),
  appearance_constraints: z.array(z.string()).optional(),
  behavior_constraints: z.array(z.string()).optional(),
  data_constraints: z.array(z.string()).optional(),
  non_goals: z.array(z.string()).optional(),
  acceptance_policy: z
    .object({
      strictness: z.enum(["strict", "balanced", "lenient"]).default("balanced"),
      allow_model_assist: z.boolean().default(true),
      observable_detail: z
        .enum(["generic", "detailed", "both"])
        .default("detailed"),
    })
    .default({
      strictness: "balanced",
      allow_model_assist: true,
      observable_detail: "detailed",
    }),
  environment_hints: z
    .object({
      baseUrl: z.string().optional(),
      loginHint: z.record(z.string(), z.unknown()).optional(),
      selectorsHint: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type SpecIR = z.infer<typeof SpecIRSchema>;
