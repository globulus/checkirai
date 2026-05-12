import { ALL_CAPABILITY_NAMES } from "../../../../src/capabilities/types.js";
import { useDashboard } from "../../context/DashboardContext";

export function GeneralVerifyCard() {
  const {
    busy,
    runVerify,
    targetUrl,
    setTargetUrl,
    tools,
    setTools,
    wantsChromeDevtools,
    setView,
    specDropActive,
    setSpecDropActive,
    loadSpecFile,
    specMarkdown,
    setSpecMarkdown,
    llmRunSummary,
    projectFileProfile,
    projectProfileNames,
  } = useDashboard();

  return (
    <div className="card col" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ fontWeight: 650 }}>Run verify_spec</div>
        <button
          type="button"
          className="btn"
          onClick={runVerify}
          disabled={busy}
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>

      <label className="muted" htmlFor="targetUrl">
        Target URL
      </label>
      <input
        id="targetUrl"
        className="input"
        value={targetUrl}
        onChange={(e) => setTargetUrl(e.target.value)}
      />

      <label className="muted" htmlFor="tools">
        Tools (comma-separated)
      </label>
      <input
        id="tools"
        className="input"
        value={tools}
        onChange={(e) => setTools(e.target.value)}
      />
      <div className="muted" style={{ marginTop: 4, lineHeight: 1.45 }}>
        Tool tokens enable integrations; verifier capabilities include:{" "}
        <span className="mono">{ALL_CAPABILITY_NAMES.join(", ")}</span>.
      </div>

      {wantsChromeDevtools ? (
        <div className="muted">
          `chrome-devtools` is enabled. Configure its MCP server in the{" "}
          <button
            type="button"
            className="linkBtn"
            onClick={() => setView("mcp")}
          >
            MCP tab
          </button>
          .
        </div>
      ) : null}

      <label className="muted" htmlFor="specMarkdown">
        Spec (markdown)
      </label>

      <fieldset
        className={`dropzone ${specDropActive ? "dropzoneActive" : ""}`}
        aria-label="Spec file dropzone"
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSpecDropActive(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSpecDropActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSpecDropActive(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setSpecDropActive(false);
          const f = e.dataTransfer.files?.[0];
          if (f) await loadSpecFile(f);
        }}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="muted">
            Drop a markdown spec file here, or pick one.
          </div>
          <label
            className="btn"
            htmlFor="specFile"
            style={{ userSelect: "none" }}
          >
            Choose file
          </label>
        </div>
        <input
          id="specFile"
          className="input"
          type="file"
          accept=".md,text/markdown,text/plain"
          style={{ display: "none" }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await loadSpecFile(f);
            e.target.value = "";
          }}
        />
      </fieldset>

      <textarea
        id="specMarkdown"
        className="textarea"
        value={specMarkdown}
        onChange={(e) => setSpecMarkdown(e.target.value)}
      />

      <div className="muted" style={{ marginTop: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          LLM policy (per role)
        </div>
        <div className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
          {llmRunSummary.llm_provider ?? "—"} · {llmRunSummary.llm_model ?? "—"}
        </div>
        <div style={{ marginTop: 6 }}>
          Edit roles, models, and Ollama host in the{" "}
          <button
            type="button"
            className="linkBtn"
            onClick={() => setView("llm")}
          >
            LLM tab
          </button>
          . The server still merges <code className="mono">profiles</code> from{" "}
          <code className="mono">checkirai.config.json</code> when{" "}
          <code className="mono">defaults.profile</code> is set
          {projectFileProfile ? (
            <>
              {" "}
              (current file: <span className="mono">{projectFileProfile}</span>)
            </>
          ) : null}
          .
        </div>
        {projectProfileNames.length ? (
          <div style={{ marginTop: 4 }}>
            Profiles in project file:{" "}
            <span className="mono">{projectProfileNames.join(", ")}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
