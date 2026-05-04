import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  type LlmPolicy,
  LlmPolicySchema,
  LlmRoleConfigSchema,
} from "../llm/types.js";

const LlmRolePatchSchema = LlmRoleConfigSchema.partial();

/** Per-profile overrides for `defaults.profile` or `CHECKIRAI_PROFILE`. */
export const LlmHardwareProfileSchema = z
  .object({
    ollamaHost: z.string().optional(),
    allowAutoPull: z.boolean().optional(),
    requireToolCapable: z.boolean().optional(),
    normalizer: LlmRolePatchSchema.optional(),
    plannerAssist: LlmRolePatchSchema.optional(),
    judge: LlmRolePatchSchema.optional(),
    triage: LlmRolePatchSchema.optional(),
  })
  .partial();
export type LlmHardwareProfile = z.infer<typeof LlmHardwareProfileSchema>;

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
      maxRunMs: z.number().int().positive().optional(),
      runCommandAllowlist: z.array(z.string()).optional(),
      stepRetries: z.number().int().nonnegative().optional(),
      stepRetryDelayMs: z.number().int().nonnegative().optional(),
      isolateProbeSessions: z.boolean().optional(),
      artifactMaxRuns: z.number().int().positive().optional(),
      /** Selects a key from top-level `profiles` to merge over `llm` defaults. */
      profile: z.string().optional(),
      allowShellMetacharacters: z.boolean().optional(),
    })
    .optional(),
  llm: LlmPolicySchema.optional(),
  profiles: z.record(z.string(), LlmHardwareProfileSchema).optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  skills: z.array(z.string()).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** Merge `base` with a named entry from `project.profiles` (no env / defaults.profile). */
export function mergeLlmPolicyWithNamedProfile(
  base: LlmPolicy,
  project: ProjectConfig | null | undefined,
  profileName: string | null | undefined,
): LlmPolicy {
  const name = profileName?.trim();
  if (!name) return base;
  const p = project?.profiles?.[name];
  if (!p) return base;
  return LlmPolicySchema.parse({
    ...base,
    ...(p.ollamaHost ? { ollamaHost: p.ollamaHost } : {}),
    ...(p.allowAutoPull !== undefined
      ? { allowAutoPull: p.allowAutoPull }
      : {}),
    ...(p.requireToolCapable !== undefined
      ? { requireToolCapable: p.requireToolCapable }
      : {}),
    normalizer: { ...base.normalizer, ...p.normalizer },
    plannerAssist: { ...base.plannerAssist, ...p.plannerAssist },
    judge: { ...base.judge, ...p.judge },
    triage: { ...base.triage, ...p.triage },
  });
}

export function mergeLlmPolicyWithProjectProfile(
  base: LlmPolicy,
  project: ProjectConfig | null | undefined,
): LlmPolicy {
  const name =
    project?.defaults?.profile?.trim() || process.env.CHECKIRAI_PROFILE?.trim();
  return mergeLlmPolicyWithNamedProfile(base, project, name);
}

export const DEFAULT_PROJECT_CONFIG_FILENAMES = [
  "checkirai.config.json",
  ".checkirai/config.json",
] as const;

export function loadProjectConfig(opts?: { rootDir?: string }): {
  config: ProjectConfig | null;
  path: string | null;
} {
  let dir = opts?.rootDir ?? process.cwd();
  for (let depth = 0; depth < 10; depth++) {
    for (const rel of DEFAULT_PROJECT_CONFIG_FILENAMES) {
      const p = join(dir, rel);
      try {
        const text = readFileSync(p, "utf8");
        const raw = JSON.parse(text) as unknown;
        return { config: ProjectConfigSchema.parse(raw), path: p };
      } catch {
        // ignore: file missing or invalid JSON/schema
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { config: null, path: null };
}
