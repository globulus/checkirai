import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ProjectConfig } from "../../config/projectConfig.js";
import {
  type RestartFromPhase,
  RestartFromPhaseSchema,
} from "../../ops/verifyOps.js";

export const VerifyCliConfigFileSchema = z
  .object({
    spec: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    tools: z.string().min(1).optional(),
    out: z.string().min(1).optional(),
    policy: z.enum(["read_only", "ui_only"]).optional(),
    llmProvider: z.enum(["ollama", "remote", "none"]).optional(),
    ollamaHost: z.string().min(1).optional(),
    ollamaModel: z.string().optional(),
    allowAutoPull: z.boolean().optional(),
    restartFrom: RestartFromPhaseSchema.optional(),
    restartRun: z.string().optional(),
  })
  .strict();

export type VerifyCliConfigFile = z.infer<typeof VerifyCliConfigFileSchema>;

export type ResolvedVerifyCli = {
  specPath?: string;
  target: string;
  tools: string;
  out: string;
  policy: "read_only" | "ui_only";
  llmProvider: "ollama" | "remote" | "none";
  ollamaHost: string;
  ollamaModel?: string;
  allowAutoPull: boolean;
  restartFrom: RestartFromPhase;
  restartRun?: string;
};

/** True if argv contains `--name` or `--name=value` (for Commander long options). */
export function argvProvidesLongFlag(argv: string[], dashedName: string) {
  const flag = `--${dashedName}`;
  return argv.some((a) => a === flag || a.startsWith(`${flag}=`));
}

const optMap = [
  ["spec", "spec"],
  ["target", "target"],
  ["tools", "tools"],
  ["out", "out"],
  ["policy", "policy"],
  ["llmProvider", "llm-provider"],
  ["ollamaHost", "ollama-host"],
  ["ollamaModel", "ollama-model"],
  ["allowAutoPull", "allow-auto-pull"],
  ["restartFrom", "restart-from"],
  ["restartRun", "restart-run"],
] as const;

type OptKey = (typeof optMap)[number][0];

function pickCliOverride<K extends OptKey>(
  argv: string[],
  key: K,
  dashed: string,
  raw: Partial<Record<OptKey, unknown>>,
): unknown {
  if (!argvProvidesLongFlag(argv, dashed)) return undefined;
  return raw[key];
}

export function loadVerifyCliConfigFile(path: string): VerifyCliConfigFile {
  const text = readFileSync(path, "utf8");
  const raw = JSON.parse(text) as unknown;
  return VerifyCliConfigFileSchema.parse(raw);
}

export function resolveVerifyCliOptions(input: {
  argv: string[];
  file: VerifyCliConfigFile | null;
  projectDefaults: ProjectConfig["defaults"] | null | undefined;
  /** Raw Commander options object (camelCase keys). */
  rawCommander: Record<string, unknown>;
}): ResolvedVerifyCli {
  const { argv, file, projectDefaults, rawCommander } = input;
  const r = rawCommander as Partial<Record<OptKey, unknown>>;

  const specPath =
    (pickCliOverride(argv, "spec", "spec", r) as string | undefined) ??
    file?.spec?.trim() ??
    undefined;

  const targetRaw =
    (pickCliOverride(argv, "target", "target", r) as string | undefined) ??
    file?.target?.trim() ??
    projectDefaults?.targetUrl?.trim();
  if (!targetRaw)
    throw new Error(
      "Missing target URL: set `target` in verify config JSON, `defaults.targetUrl` in checkirai.config.json, or pass --target <url>.",
    );

  const tools =
    (pickCliOverride(argv, "tools", "tools", r) as string | undefined) ??
    file?.tools ??
    projectDefaults?.tools ??
    "fs,http";

  const out =
    (pickCliOverride(argv, "out", "out", r) as string | undefined) ??
    file?.out ??
    projectDefaults?.outRoot ??
    ".verifier";

  const policyRaw =
    (pickCliOverride(argv, "policy", "policy", r) as string | undefined) ??
    file?.policy ??
    "read_only";
  const policy = policyRaw === "ui_only" ? "ui_only" : "read_only";

  const llmProviderRaw =
    (pickCliOverride(argv, "llmProvider", "llm-provider", r) as
      | string
      | undefined) ??
    file?.llmProvider ??
    "ollama";
  const llmProvider =
    llmProviderRaw === "remote" || llmProviderRaw === "none"
      ? llmProviderRaw
      : "ollama";

  const ollamaHost =
    (pickCliOverride(argv, "ollamaHost", "ollama-host", r) as
      | string
      | undefined) ??
    file?.ollamaHost ??
    "http://127.0.0.1:11434";

  const ollamaModelRaw =
    (pickCliOverride(argv, "ollamaModel", "ollama-model", r) as
      | string
      | undefined) ?? file?.ollamaModel;
  const ollamaModel =
    typeof ollamaModelRaw === "string" && ollamaModelRaw.trim()
      ? ollamaModelRaw.trim()
      : undefined;

  const allowAutoPull = argvProvidesLongFlag(argv, "allow-auto-pull")
    ? Boolean(r.allowAutoPull)
    : (file?.allowAutoPull ?? true);

  const restartFromRaw =
    (pickCliOverride(argv, "restartFrom", "restart-from", r) as
      | string
      | undefined) ?? file?.restartFrom;
  const restartFrom = RestartFromPhaseSchema.parse(restartFromRaw ?? "start");

  const restartRunRaw =
    (pickCliOverride(argv, "restartRun", "restart-run", r) as
      | string
      | undefined) ?? file?.restartRun;
  const restartRun =
    typeof restartRunRaw === "string" && restartRunRaw.trim()
      ? restartRunRaw.trim()
      : undefined;

  return {
    ...(specPath !== undefined ? { specPath } : {}),
    target: targetRaw,
    tools,
    out,
    policy,
    llmProvider,
    ollamaHost,
    ...(ollamaModel !== undefined ? { ollamaModel } : {}),
    allowAutoPull,
    restartFrom,
    ...(restartRun !== undefined ? { restartRun } : {}),
  };
}
