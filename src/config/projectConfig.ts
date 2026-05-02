import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LlmPolicySchema } from "../llm/types.js";

export const McpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const ProjectConfigSchema = z.object({
  version: z.literal(1).default(1),
  defaults: z
    .object({
      targetUrl: z.string().optional(),
      tools: z.string().optional(),
      outRoot: z.string().optional(),
    })
    .optional(),
  llm: LlmPolicySchema.optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  skills: z.array(z.string()).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const DEFAULT_PROJECT_CONFIG_FILENAMES = [
  "checkirai.config.json",
  ".checkirai/config.json",
] as const;

export function loadProjectConfig(opts?: { rootDir?: string }): {
  config: ProjectConfig | null;
  path: string | null;
} {
  const root = opts?.rootDir ?? process.cwd();
  for (const rel of DEFAULT_PROJECT_CONFIG_FILENAMES) {
    const p = join(root, rel);
    try {
      const text = readFileSync(p, "utf8");
      const raw = JSON.parse(text) as unknown;
      return { config: ProjectConfigSchema.parse(raw), path: p };
    } catch {
      // ignore: file missing or invalid JSON/schema
    }
  }
  return { config: null, path: null };
}
