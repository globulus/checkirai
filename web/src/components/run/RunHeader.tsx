import { useDashboard } from "../../context/DashboardContext";

export function RunHeader() {
  const { selectedRun, runLiveCaptionById } = useDashboard();

  return (
    <div
      className="row"
      style={{ justifyContent: "space-between", marginBottom: 12 }}
    >
      <div className="h1" style={{ margin: 0 }}>
        {selectedRun ? (
          <>
            Run <span className="mono">{selectedRun.id}</span>
          </>
        ) : (
          "Run"
        )}
      </div>
      {selectedRun ? (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <span
            className="badge"
            title={
              selectedRun.status === "running" &&
              runLiveCaptionById[selectedRun.id]
                ? runLiveCaptionById[selectedRun.id]
                : undefined
            }
          >
            {selectedRun.status ?? "unknown"}
            {selectedRun.status === "running" &&
            runLiveCaptionById[selectedRun.id]
              ? ` · ${runLiveCaptionById[selectedRun.id]}`
              : ""}
            {typeof selectedRun.confidence === "number"
              ? ` • conf ${selectedRun.confidence.toFixed(2)}`
              : ""}
          </span>
          {selectedRun.parent_run_id ? (
            <span className="badge" title="Restart lineage">
              from {selectedRun.parent_run_id.slice(0, 8)} •{" "}
              {selectedRun.restart_from_phase ?? "start"}
            </span>
          ) : null}
          {selectedRun.llm_model ? (
            <span
              className="badge mono"
              title={`LLM: ${selectedRun.llm_provider ?? ""}`}
              style={{
                maxWidth: 360,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {selectedRun.llm_model}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
