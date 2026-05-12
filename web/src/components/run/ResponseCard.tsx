import { useDashboard } from "../../context/DashboardContext";
import { safeJson } from "../../lib/format";

export function ResponseCard() {
  const { lastResponse } = useDashboard();

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ fontWeight: 650 }}>Response</div>
        <div className="muted">
          {lastResponse ? new Date(lastResponse.ts).toLocaleString() : ""}
        </div>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>
        {lastResponse?.title ?? "No responses yet."}
      </div>
      <div className="events" style={{ marginTop: 8, maxHeight: 340 }}>
        <pre className="mono">
          {lastResponse ? safeJson(lastResponse.body) : ""}
        </pre>
      </div>
    </div>
  );
}
