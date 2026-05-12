import type { LlmPolicy } from "../../../src/llm/types.js";

export type SidebarView = "general" | "mcp" | "llm";

export type RestartPhase = "start" | "spec_ir" | "llm_plan";

export type TimelineItem = {
  ts: string;
  level: "info" | "success" | "warn" | "error";
  title: string;
  body?: unknown;
  source: "client" | "backend";
  runId?: string | null;
};

export type LlmCallRecord = {
  ts: string;
  phase?: unknown;
  provider?: unknown;
  host?: unknown;
  model?: unknown;
  durationMs?: unknown;
  promptChars?: unknown;
  responseChars?: unknown;
  truncated?: unknown;
  system?: unknown;
  prompt?: unknown;
  responseText?: unknown;
};

export type ModelCatalog = {
  ollama?: { ok?: boolean; version?: string };
  installed?: Array<{ name?: unknown }>;
  recommended?: Array<{
    name?: string;
    notes?: string;
    approxQ4RamGiB?: number;
  }>;
  hardware?: {
    totalMemBytes: number;
    totalMemGiB: number;
    suggestedProfileKey: string;
    profileExistsInProject: boolean;
    rationale: string;
    maxApproxQ4RamGiBForCatalog: number;
    previewLlmPolicy?: LlmPolicy;
  };
};

export type LastResponse = {
  title: string;
  body: unknown;
  ts: string;
};
