import { useDashboard } from "../../context/DashboardContext";
import { safeJson } from "../../lib/format";

export function LlmActivityCard() {
  const { selectedRunId, llmCallsByRunId } = useDashboard();

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ fontWeight: 650 }}>LLM activity</div>
        <div className="muted">
          {selectedRunId && llmCallsByRunId[selectedRunId]?.length
            ? `${llmCallsByRunId[selectedRunId]?.length} call(s)`
            : "No LLM calls yet."}
        </div>
      </div>
      <div className="events" style={{ marginTop: 8, maxHeight: 340 }}>
        <pre className="mono">
          {selectedRunId && llmCallsByRunId[selectedRunId]?.length
            ? safeJson(llmCallsByRunId[selectedRunId]?.slice(-3))
            : "When a local LLM is used, its prompt/response will appear here."}
        </pre>
      </div>
    </div>
  );
}
