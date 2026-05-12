import type { ChildProcess } from "node:child_process";
import type { ProjectConfig } from "../../config/projectConfig.js";
import type { LlmPolicy } from "../../llm/types.js";
import type { PolicyName } from "../../policies/policy.js";
import type { SpecIR } from "../../spec/ir.js";
import type { OpsContext } from "../context.js";
import type { RunEvent, RunEventSink } from "../events.js";
import type { RestartFromPhase, VerifySpecInput } from "./types.js";

export type VerifyRunContext = {
  ctx: OpsContext;
  input: VerifySpecInput;
  opts:
    | { onEvent?: RunEventSink; runId?: string; signal?: AbortSignal }
    | undefined;
  outRoot: string;
  runsDir: string;
  artifactsDir: string;
  projectCfg: ProjectConfig | null | undefined;
  maxRunMs: number | undefined;
  runCommandAllowlist: string[] | undefined;
  stepRetries: number | undefined;
  stepRetryDelayMs: number | undefined;
  isolateProbeSessions: boolean | undefined;
  allowShellMetacharacters: boolean;
  llmPolicy: LlmPolicy;
  requestedPolicy: PolicyName;
  restartFromPhase: RestartFromPhase;
  parentRunId: string | undefined;
  runId: string;
  createdAt: string;
  start: number;
  lineageParent: string | null;
  lineagePhase: RestartFromPhase | null;
  publish: (e: RunEvent) => void;
  recordModel: (m: string) => void;
  ollamaModelsUsed: Set<string>;
  launchChild: { current?: ChildProcess };
  runAbortSignal: AbortSignal | undefined;
  disposeRunAbort: () => void;
  dartProjectRoot: string | undefined;
  specIr: SpecIR | undefined;
};
