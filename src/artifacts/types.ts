import { z } from "zod";

export const ArtifactTypeSchema = z.enum([
  "a11y_snapshot",
  "screenshot",
  "network_log",
  "console_log",
  "http_response",
  "file_read",
  "tool_output",
  "llm_prompt",
  "llm_output",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactRefSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  path: z.string(),
  sha256: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
