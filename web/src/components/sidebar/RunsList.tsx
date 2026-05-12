import { useDashboard } from "../../context/DashboardContext";
import { fmt } from "../../lib/format";

export function RunsList() {
  const { runs, selectedRunId, setSelectedRunId, refreshRuns, busy } =
    useDashboard();

  return (
    <>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 8 }}
      >
        <div style={{ fontWeight: 650 }}>Recent runs</div>
        <button
          type="button"
          className="btn"
          onClick={() => refreshRuns()}
          disabled={busy}
        >
          Refresh
        </button>
      </div>

      <div className="list">
        {runs.map((r) => (
          <button
            type="button"
            key={r.id}
            className="item"
            onClick={(e) => {
              e.preventDefault();
              setSelectedRunId(r.id);
            }}
            style={{
              outline: r.id === selectedRunId ? "2px solid #334155" : "none",
              textAlign: "left",
            }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="mono">{r.id.slice(0, 8)}</div>
              <span className="badge">{r.status ?? "unknown"}</span>
            </div>
            <div className="muted">{fmt(r.created_at)}</div>
            <div className="muted" style={{ wordBreak: "break-word" }}>
              {r.target_base_url}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
