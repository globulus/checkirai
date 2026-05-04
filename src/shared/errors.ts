export type ErrorCode =
  | "CONFIG_ERROR"
  | "POLICY_BLOCKED"
  | "TOOL_UNAVAILABLE"
  /** In-page script threw or returned non-serializable data (e.g. chrome-devtools evaluate_script). */
  | "EVAL_SCRIPT_FAILED"
  | "TIMEOUT"
  | "OLLAMA_NOT_RUNNING"
  | "OLLAMA_MODEL_MISSING"
  | "LLM_PROVIDER_ERROR";

export class VerifierError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "VerifierError";
    this.code = code;
    if (opts && "cause" in opts) {
      this.cause = opts.cause;
    }
    if (opts?.details) {
      this.details = opts.details;
    }
  }
}
