import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineItem } from "../types/dashboard";

export function useTimeline(selectedRunId: string | null, busy: boolean) {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const log = useCallback(
    (item: Omit<TimelineItem, "ts"> & { ts?: string }) => {
      const ts = item.ts ?? new Date().toISOString();
      setTimeline((prev) => {
        const next = prev.length > 900 ? prev.slice(prev.length - 900) : prev;
        return [...next, { ts, ...item }];
      });
    },
    [],
  );

  const timelineForSelectedRun = useMemo(() => {
    const rid = selectedRunId;
    const items = rid
      ? timeline.filter((t) => (t.runId ?? null) === rid)
      : timeline;
    return items.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  }, [selectedRunId, timeline]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when timeline grows or busy toggles
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [timelineForSelectedRun.length, busy]);

  return {
    timeline,
    setTimeline,
    timelineRef,
    log,
    timelineForSelectedRun,
  };
}
