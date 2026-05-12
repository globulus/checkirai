import { z } from "zod";
import type { LlmPolicy } from "../../llm/types.js";
import type { PolicyName } from "../../policies/policy.js";
import type { SpecBundle } from "../../spec/bundle.js";
import type { SpecIR } from "../../spec/ir.js";

export const RestartFromPhaseSchema = z.enum(["start", "spec_ir", "llm_plan"]);
export type RestartFromPhase = z.infer<typeof RestartFromPhaseSchema>;

export const ARTIFACT_KIND_SPEC_IR = "spec_ir";
export const ARTIFACT_KIND_TEST_PLAN_IR = "test_plan_ir";

export type VerifySpecInput = {
  specMarkdown?: string;
  spec?: SpecIR;
  specBundle?: SpecBundle;
  targetUrl: string;
  tools?: string;
  policyName?: PolicyName;
  llm?: LlmPolicy;
  outDir?: string;
  chromeDevtoolsServer?: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  dartMcpServer?: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  dartProjectRoot?: string;
  dartDriverDevice?: string;
  restartFromPhase?: RestartFromPhase;
  restartFromRunId?: string;
  maxRunMs?: number;
  runCommandAllowlist?: string[];
  stepRetries?: number;
  stepRetryDelayMs?: number;
  isolateProbeSessions?: boolean;
  artifactMaxRuns?: number;
  launchCommand?: string;
  launchCwd?: string;
  launchReadyTimeoutMs?: number;
  selfTestTargetBaseUrl?: string;
};
