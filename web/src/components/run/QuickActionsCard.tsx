import { command } from "../../api";
import { useDashboard } from "../../context/DashboardContext";

export function QuickActionsCard() {
  const {
    selectedRunId,
    runGraph,
    setBusy,
    setError,
    log,
    respond,
    llmPolicy,
    refreshModelCatalog,
  } = useDashboard();

  return (
    <div className="card">
      <div style={{ fontWeight: 650, marginBottom: 8 }}>Quick actions</div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          disabled={!selectedRunId}
          onClick={async () => {
            if (!selectedRunId) return;
            setBusy(true);
            setError(null);
            log({
              level: "info",
              title: "Quick action: get_artifact (first)",
              source: "client",
              runId: selectedRunId,
            });
            try {
              const out = await command("get_artifact", {
                runId: selectedRunId,
                artifactId:
                  (runGraph?.artifacts?.[0] as { id?: unknown } | undefined)
                    ?.id ?? "",
              });
              respond("get_artifact", out);
              log({
                level: "success",
                title: "Quick action finished: get_artifact",
                body: out,
                source: "client",
                runId: selectedRunId,
              });
            } catch (e: unknown) {
              const err = e as { message?: unknown };
              const msg =
                typeof err?.message === "string" ? err.message : String(e);
              setError(msg);
              log({
                level: "error",
                title: "Quick action failed: get_artifact",
                body: msg,
                source: "client",
                runId: selectedRunId,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          Show first artifact (JSON)
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setBusy(true);
            setError(null);
            log({
              level: "info",
              title: "Quick action: ollama_status",
              source: "client",
            });
            try {
              const out = await command("ollama_status", {
                host: llmPolicy.ollamaHost,
              });
              respond("ollama_status", out);
              log({
                level: "success",
                title: "Quick action finished: ollama_status",
                body: out,
                source: "client",
              });
            } catch (e: unknown) {
              const err = e as { message?: unknown };
              const msg =
                typeof err?.message === "string" ? err.message : String(e);
              setError(msg);
              log({
                level: "error",
                title: "Quick action failed: ollama_status",
                body: msg,
                source: "client",
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          Ollama status
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setBusy(true);
            setError(null);
            log({
              level: "info",
              title: "Quick action: refresh models",
              source: "client",
            });
            try {
              await refreshModelCatalog();
              const out = await command("ollama_daemon_status", {});
              respond("ollama_daemon_status", out);
              log({
                level: "success",
                title: "Quick action finished: refresh models",
                body: out,
                source: "client",
              });
            } catch (e: unknown) {
              const err = e as { message?: unknown };
              const msg =
                typeof err?.message === "string" ? err.message : String(e);
              setError(msg);
              log({
                level: "error",
                title: "Quick action failed: refresh models",
                body: msg,
                source: "client",
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          Refresh models
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setBusy(true);
            setError(null);
            log({
              level: "info",
              title: "Quick action: start Ollama",
              source: "client",
            });
            try {
              const out = await command("ollama_daemon_start", {
                host: llmPolicy.ollamaHost,
              });
              await refreshModelCatalog();
              respond("ollama_daemon_start", out);
              log({
                level: "success",
                title: "Quick action finished: start Ollama",
                body: out,
                source: "client",
              });
            } catch (e: unknown) {
              const err = e as { message?: unknown };
              const msg =
                typeof err?.message === "string" ? err.message : String(e);
              setError(msg);
              log({
                level: "error",
                title: "Quick action failed: start Ollama",
                body: msg,
                source: "client",
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          Start Ollama
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setBusy(true);
            setError(null);
            log({
              level: "info",
              title: "Quick action: stop Ollama",
              source: "client",
            });
            try {
              const out = await command("ollama_daemon_stop", {});
              await refreshModelCatalog();
              respond("ollama_daemon_stop", out);
              log({
                level: "success",
                title: "Quick action finished: stop Ollama",
                body: out,
                source: "client",
              });
            } catch (e: unknown) {
              const err = e as { message?: unknown };
              const msg =
                typeof err?.message === "string" ? err.message : String(e);
              setError(msg);
              log({
                level: "error",
                title: "Quick action failed: stop Ollama",
                body: msg,
                source: "client",
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          Stop Ollama
        </button>
      </div>
    </div>
  );
}
