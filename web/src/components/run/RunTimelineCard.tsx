import { useDashboard } from "../../context/DashboardContext";
import { fmt, safeJson } from "../../lib/format";

export function RunTimelineCard() {
  const {
    busy,
    selectedRunId,
    setTimeline,
    timelineRef,
    timelineForSelectedRun,
  } = useDashboard();

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ fontWeight: 650 }}>Run timeline</div>
        <button
          type="button"
          className="btn"
          onClick={() => setTimeline([])}
          disabled={busy}
        >
          Clear
        </button>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>
        {selectedRunId
          ? `Showing timeline for ${selectedRunId}`
          : "No run selected — showing global activity."}
      </div>
      <div
        className="events timeline"
        ref={timelineRef}
        style={{ marginTop: 8 }}
      >
        {timelineForSelectedRun.length ? (
          <div className="timelineList">
            {timelineForSelectedRun.map((t) => (
              <div
                key={`${t.ts}-${t.title}-${t.level}-${t.source}`}
                className={`timelineRow level-${t.level}`}
              >
                <div className="timelineMeta">
                  <span className="timelineTs mono">{fmt(t.ts)}</span>
                  <span className="badge">{t.source}</span>
                  <span className="badge">{t.level}</span>
                </div>
                <div className="timelineTitle">{t.title}</div>
                {t.body != null ? (
                  <pre className="mono timelineBody">{safeJson(t.body)}</pre>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">
            No timeline entries yet. Click Run and you should see steps
            immediately.
          </div>
        )}
      </div>
    </div>
  );
}
