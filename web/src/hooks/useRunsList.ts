import { useCallback, useEffect, useMemo, useState } from "react";
import { listRuns, type RunRow } from "../api";

export function useRunsList(setError: (error: string | null) => void) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const refreshRuns = useCallback(async () => {
    const out = await listRuns(80);
    setRuns(out.runs);
    if (!selectedRunId && out.runs[0]?.id) setSelectedRunId(out.runs[0].id);
  }, [selectedRunId]);

  useEffect(() => {
    refreshRuns().catch((e) => setError(String(e?.message ?? e)));
    const t = setInterval(() => refreshRuns().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [refreshRuns, setError]);

  return {
    runs,
    selectedRunId,
    setSelectedRunId,
    selectedRun,
    refreshRuns,
  };
}
