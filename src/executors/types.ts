import { z } from "zod";

export const ToolCallRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  probeId: z.string().optional(),
  capability: z.string(),
  action: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  ok: z.boolean(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  outputArtifactId: z.string().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;
