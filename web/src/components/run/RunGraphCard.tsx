import { useDashboard } from "../../context/DashboardContext";
import { safeJson } from "../../lib/format";

export function RunGraphCard() {
  const { runGraph } = useDashboard();

  return (
    <div className="card">
      <div style={{ fontWeight: 650, marginBottom: 8 }}>
        Run graph (latest snapshot)
      </div>
      <div className="events">
        <pre className="mono">
          {runGraph ? safeJson(runGraph) : "No run selected."}
        </pre>
      </div>
    </div>
  );
}
