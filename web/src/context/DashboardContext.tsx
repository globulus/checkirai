import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { type LlmPolicy, LlmPolicySchema } from "../../../src/llm/types.js";
import { useLlmPolicyForm } from "../hooks/useLlmPolicyForm";
import { useModelCatalog } from "../hooks/useModelCatalog";
import { useRunStream } from "../hooks/useRunStream";
import { useRunsList } from "../hooks/useRunsList";
import { useTimeline } from "../hooks/useTimeline";
import { useVerifyForm } from "../hooks/useVerifyForm";
import type { LastResponse, SidebarView } from "../types/dashboard";

type DashboardContextValue = ReturnType<typeof useDashboardState>;

const DashboardContext = createContext<DashboardContextValue | null>(null);

function useDashboardState() {
  const [view, setView] = useState<SidebarView>("general");
  const [lastResponse, setLastResponse] = useState<LastResponse | null>(null);
  const [llmPolicy, setLlmPolicy] = useState<LlmPolicy>(() =>
    LlmPolicySchema.parse({}),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const respond = useCallback((title: string, body: unknown) => {
    setLastResponse({ title, body, ts: new Date().toISOString() });
  }, []);

  const runsList = useRunsList(setError);
  const timeline = useTimeline(runsList.selectedRunId, busy);
  const modelCatalogState = useModelCatalog(llmPolicy.ollamaHost);
  const llmForm = useLlmPolicyForm(
    llmPolicy,
    setLlmPolicy,
    modelCatalogState.modelCatalog,
  );

  const verifyForm = useVerifyForm({
    log: timeline.log,
    respond,
    selectedRunId: runsList.selectedRunId,
    selectedRun: runsList.selectedRun,
    refreshRuns: runsList.refreshRuns,
    setSelectedRunId: runsList.setSelectedRunId,
    llmPolicy,
    setLlmPolicy,
    llmRunSummary: llmForm.llmRunSummary,
    busy,
    setBusy,
    error,
    setError,
  });

  const runStream = useRunStream({
    selectedRunId: runsList.selectedRunId,
    selectedRunStatus: runsList.selectedRun?.status,
    selectedRunIdForCaption: runsList.selectedRun?.id,
    log: timeline.log,
    setError,
  });

  return useMemo(
    () => ({
      view,
      setView,
      lastResponse,
      respond,
      llmPolicy,
      setLlmPolicy,
      ...runsList,
      ...runStream,
      ...timeline,
      ...modelCatalogState,
      ...llmForm,
      ...verifyForm,
    }),
    [
      view,
      lastResponse,
      respond,
      llmPolicy,
      runsList,
      runStream,
      timeline,
      modelCatalogState,
      llmForm,
      verifyForm,
    ],
  );
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const value = useDashboardState();
  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) {
    throw new Error("useDashboard must be used within DashboardProvider");
  }
  return ctx;
}
