import { updateRunStatus } from "../../persistence/repo/runRepo.js";
import { nowIso } from "./artifacts.js";
import type { VerifyRunContext } from "./context.js";

export function handleRunFailure(run: VerifyRunContext, e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  const aborted =
    (e instanceof Error && e.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      e instanceof DOMException &&
      e.name === "AbortError");
  const userInterrupted = Boolean(aborted && run.opts?.signal?.aborted);
  const runTerminalStatus = userInterrupted
    ? "cancelled"
    : aborted
      ? "timed_out"
      : "error";
  const code =
    e &&
    typeof e === "object" &&
    "code" in e &&
    typeof (e as { code?: unknown }).code === "string"
      ? (e as { code: string }).code
      : undefined;
  const details =
    e && typeof e === "object" && "details" in e
      ? (e as { details: unknown }).details
      : undefined;

  updateRunStatus(run.ctx.db, run.runId, runTerminalStatus, 0);
  run.publish({
    type: "run_error",
    runId: run.runId,
    ts: nowIso(),
    message: userInterrupted ? "Run cancelled (interrupt)." : message,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  });
  run.publish({
    type: "run_finished",
    runId: run.runId,
    endedAt: nowIso(),
    status: runTerminalStatus,
    confidence: 0,
  });
  throw e;
}
