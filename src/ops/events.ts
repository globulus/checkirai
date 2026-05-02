export type RunEvent =
  | {
      type: "run_queued";
      runId: string;
      createdAt: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: "run_error";
      runId: string;
      ts: string;
      message: string;
      code?: string;
      details?: unknown;
    }
  | {
      type: "run_started";
      runId: string;
      createdAt: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: "llm_call";
      runId: string;
      startedAt: string;
      endedAt: string;
      phase: string;
      provider: string;
      host: string;
      model: string;
      durationMs: number;
      promptChars: number;
      responseChars: number;
      truncated?: unknown;
      system?: string;
      prompt: string;
      responseText: string;
    }
  | {
      type: "probe_started";
      runId: string;
      probeId: string;
      requirementId?: string;
    }
  | {
      type: "step_started";
      runId: string;
      probeId?: string;
      toolCallId: string;
      capability: string;
      action: string;
      startedAt: string;
      args?: unknown;
    }
  | {
      type: "step_finished";
      runId: string;
      probeId?: string;
      toolCallId: string;
      capability: string;
      action: string;
      startedAt: string;
      endedAt: string;
      ok: boolean;
      errorCode?: string;
      errorMessage?: string;
      outputArtifactId?: string;
      result?: unknown;
    }
  | {
      type: "run_finished";
      runId: string;
      endedAt: string;
      status: string;
      confidence?: number;
    };

export type RunEventSink = (event: RunEvent) => void;
