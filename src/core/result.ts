import { z } from "zod";
import { ArtifactRefSchema } from "../artifacts/types.js";

export const VerdictSchema = z.enum([
  "pass",
  "fail",
  "inconclusive",
  "blocked",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const JudgmentModeSchema = z.enum([
  "deterministic",
  "model_assisted",
  "mixed",
]);
export type JudgmentMode = z.infer<typeof JudgmentModeSchema>;

export const RequirementResultSchema = z.object({
  requirement_id: z.string(),
  verdict: VerdictSchema,
  confidence: z.number().min(0).max(1),
  judgment_mode: JudgmentModeSchema,
  evidence_refs: z.array(ArtifactRefSchema).default([]),
  expected: z.record(z.string(), z.unknown()).optional(),
  observed: z.record(z.string(), z.unknown()).optional(),
  diff: z.record(z.string(), z.unknown()).optional(),
  why_failed_or_blocked: z.string().optional(),
  repair_hint: z.string().optional(),
});
export type RequirementResult = z.infer<typeof RequirementResultSchema>;

export const VerificationResultSchema = z.object({
  overall_status: VerdictSchema,
  coverage_summary: z.object({
    total: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    inconclusive: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  requirements: z.array(RequirementResultSchema).default([]),
  artifacts: z.array(ArtifactRefSchema).default([]),
  tool_trace_summary: z.object({
    toolCalls: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  blocked_reasons: z.array(z.string()).optional(),
  suggested_repairs: z.array(z.string()).optional(),
  repro_steps: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
  next_best_checks: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
