import { useDashboard } from "../../context/DashboardContext";
import { safeJson } from "../../lib/format";

export function SpecIrCard() {
  const { selectedRunId, inputSpecIrByRunId } = useDashboard();

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 650, marginBottom: 8 }}>Input Spec IR</div>
      <div className="events" style={{ maxHeight: 340 }}>
        <pre className="mono">
          {selectedRunId && selectedRunId in inputSpecIrByRunId
            ? safeJson(inputSpecIrByRunId[selectedRunId])
            : "Start a run (or keep the tab open) to capture the input IR."}
        </pre>
      </div>
    </div>
  );
}
