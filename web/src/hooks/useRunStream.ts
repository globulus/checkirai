import { useEffect, useState } from "react";
import {
  getRun,
  type RunEvent,
  type RunGraph,
  subscribeRunEvents,
} from "../api";
import { formatLiveStepLabel } from "../lib/format";
import type { LlmCallRecord, TimelineItem } from "../types/dashboard";

type LogFn = (item: Omit<TimelineItem, "ts"> & { ts?: string }) => void;

export function useRunStream(options: {
  selectedRunId: string | null;
  selectedRunStatus?: string | null;
  selectedRunIdForCaption?: string;
  log: LogFn;
  setError: (error: string | null) => void;
}) {
  const { selectedRunId, log, setError } = options;

  const [runGraph, setRunGraph] = useState<RunGraph | null>(null);
  const [events, setEvents] = useState<
    Array<RunEvent & { _receivedAt: string }>
  >([]);
  const [inputSpecIrByRunId, setInputSpecIrByRunId] = useState<
    Record<string, unknown>
  >({});
  const [llmCallsByRunId, setLlmCallsByRunId] = useState<
    Record<string, LlmCallRecord[]>
  >({});
  const [runLiveCaptionById, setRunLiveCaptionById] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (!options.selectedRunIdForCaption) return;
    if (options.selectedRunStatus === "running") return;
    const runId = options.selectedRunIdForCaption;
    setRunLiveCaptionById((prev) => {
      if (!prev[runId]) return prev;
      const next = { ...prev };
      delete next[runId];
      return next;
    });
  }, [options.selectedRunIdForCaption, options.selectedRunStatus]);

  useEffect(() => {
    if (!selectedRunId) return;
    let unsub = () => {};

    setEvents([]);
    setRunLiveCaptionById((prev) => {
      const next = { ...prev };
      delete next[selectedRunId];
      return next;
    });
    log({
      level: "info",
      title: `Selected run ${selectedRunId}`,
      source: "client",
      runId: selectedRunId,
    });
    getRun(selectedRunId)
      .then((g) => setRunGraph(g))
      .catch((e) => setError(String(e?.message ?? e)));

    unsub = subscribeRunEvents(selectedRunId, (e) => {
      const receivedAt = new Date().toISOString();
      setEvents((prev) => {
        const next = prev.length > 300 ? prev.slice(prev.length - 300) : prev;
        return [...next, { ...e, _receivedAt: receivedAt }];
      });
      log({
        level: "info",
        title: `event: ${String(e?.type ?? "message")}`,
        body: e,
        source: "backend",
        runId: selectedRunId,
        ts: receivedAt,
      });

      const rid =
        e && typeof e === "object" && typeof (e as RunEvent).runId === "string"
          ? (e as RunEvent).runId
          : selectedRunId;

      if (
        e?.type === "step_started" ||
        e?.type === "probe_started" ||
        e?.type === "run_started"
      ) {
        const label = formatLiveStepLabel(e as RunEvent);
        if (label && rid)
          setRunLiveCaptionById((prev) => ({ ...prev, [rid]: label }));
      } else if (e?.type === "step_finished" && rid) {
        setRunLiveCaptionById((prev) => ({
          ...prev,
          [rid]: "Continuing…",
        }));
      } else if (
        (e?.type === "run_finished" || e?.type === "run_error") &&
        rid
      ) {
        setRunLiveCaptionById((prev) => {
          const next = { ...prev };
          delete next[rid];
          return next;
        });
      }

      if (e?.type === "run_started") {
        const meta =
          e && typeof e === "object" && "meta" in e
            ? (e as { meta?: unknown }).meta
            : null;
        const specIr =
          meta && typeof meta === "object" && meta && "specIr" in meta
            ? (meta as { specIr?: unknown }).specIr
            : null;
        if (specIr != null) {
          setInputSpecIrByRunId((prev) => ({
            ...prev,
            [selectedRunId]: specIr,
          }));
        }
      }

      if (e?.type === "llm_call") {
        const ev = e as RunEvent & Record<string, unknown>;
        setLlmCallsByRunId((prev) => {
          const cur = prev[selectedRunId] ?? [];
          const next = cur.length > 80 ? cur.slice(cur.length - 80) : cur;
          return {
            ...prev,
            [selectedRunId]: [
              ...next,
              {
                ts: receivedAt,
                phase: ev.phase,
                provider: ev.provider,
                host: ev.host,
                model: ev.model,
                durationMs: ev.durationMs,
                promptChars: ev.promptChars,
                responseChars: ev.responseChars,
                truncated: ev.truncated,
                system: ev.system,
                prompt: ev.prompt,
                responseText: ev.responseText,
              },
            ],
          };
        });
      }

      if (e?.type === "run_error") {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as { message?: unknown }).message ?? "")
            : "run_error";
        if (msg) setError(msg);
      }
    });

    const poll = setInterval(() => {
      getRun(selectedRunId)
        .then((g) => setRunGraph(g))
        .catch(() => {});
    }, 2500);

    return () => {
      unsub();
      clearInterval(poll);
    };
  }, [selectedRunId, log, setError]);

  return {
    runGraph,
    events,
    inputSpecIrByRunId,
    llmCallsByRunId,
    runLiveCaptionById,
  };
}
