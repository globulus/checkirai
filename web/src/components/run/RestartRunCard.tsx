import { useDashboard } from "../../context/DashboardContext";
import type { RestartPhase } from "../../types/dashboard";

export function RestartRunCard() {
  const { selectedRun, busy, rerunFromPhase, restartPhase, setRestartPhase } =
    useDashboard();

  if (!selectedRun) return null;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ fontWeight: 650 }}>Restart this run</div>
        <button
          type="button"
          className="btn"
          onClick={rerunFromPhase}
          disabled={busy}
        >
          {busy ? "Working…" : "Rerun from phase"}
        </button>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>
        Uses cached artifacts from the selected run to skip earlier phases.
      </div>
      <label className="muted" htmlFor="restartPhase" style={{ marginTop: 10 }}>
        Phase
      </label>
      <select
        id="restartPhase"
        className="select"
        value={restartPhase}
        onChange={(e) => setRestartPhase(e.target.value as RestartPhase)}
      >
        <option value="start">start (full rerun)</option>
        <option value="spec_ir">spec_ir (reuse normalized IR)</option>
        <option value="llm_plan">llm_plan (reuse IR + cached plan)</option>
      </select>
      <div className="muted" style={{ marginTop: 6 }}>
        Note: `llm_plan` requires the cached plan to match the current Chrome
        DevTools MCP tool surface.
      </div>
    </div>
  );
}
