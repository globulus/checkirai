import { LlmPolicySchema } from "../../../../src/llm/types.js";
import { command } from "../../api";
import { useDashboard } from "../../context/DashboardContext";
import { safeJson } from "../../lib/format";
import { LLM_ROLES, ROLE_LABELS } from "../../lib/llmUi";

export function ModelCatalogCard() {
  const {
    busy,
    setBusy,
    setError,
    refreshModelCatalog,
    modelCatalog,
    setLlmPolicy,
    modelAssignRole,
    setModelAssignRole,
    updateLlmRole,
    llmPolicy,
  } = useDashboard();

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div style={{ fontWeight: 650 }}>Model catalog</div>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await refreshModelCatalog();
            } catch (e: unknown) {
              const err = e as { message?: unknown };
              setError(
                typeof err?.message === "string" ? err.message : String(e),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Refresh
        </button>
      </div>

      <div className="muted" style={{ marginTop: 6 }}>
        Status:{" "}
        <span className="mono">
          {modelCatalog?.ollama?.ok
            ? `ok (v${modelCatalog?.ollama?.version ?? "?"})`
            : "not running"}
        </span>
      </div>

      {modelCatalog?.hardware ? (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            background: "#1e293b",
            borderRadius: 6,
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontWeight: 650, marginBottom: 6 }}>
            Host RAM (API machine)
          </div>
          <div className="muted">
            ~<span className="mono">{modelCatalog.hardware.totalMemGiB}</span>{" "}
            GiB total system memory · suggested{" "}
            <code className="mono">
              profiles.{modelCatalog.hardware.suggestedProfileKey}
            </code>
            {!modelCatalog.hardware.profileExistsInProject ? (
              <span>
                {" "}
                (not defined in your project file — add it from the sample
                config to enable one-click merge)
              </span>
            ) : null}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            {modelCatalog.hardware.rationale}
          </div>
          <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
            Pull list below is filtered to models with approximate Q4 footprint
            ≤{" "}
            <span className="mono">
              {modelCatalog.hardware.maxApproxQ4RamGiBForCatalog}
            </span>{" "}
            GiB (heuristic for one large model + overhead; see implementation
            plan).
          </div>
          {modelCatalog.hardware.profileExistsInProject &&
          modelCatalog.hardware.previewLlmPolicy ? (
            <button
              type="button"
              className="btn"
              style={{ marginTop: 10 }}
              disabled={busy}
              onClick={() =>
                setLlmPolicy(
                  LlmPolicySchema.parse(
                    modelCatalog.hardware?.previewLlmPolicy,
                  ),
                )
              }
            >
              Apply suggested profile to LLM form
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 12, gap: 12, flexWrap: "wrap" }}>
        <label className="muted" htmlFor="modelAssignRole">
          “Use for verify” sets model for role
        </label>
        <select
          id="modelAssignRole"
          className="select"
          style={{ minWidth: 160 }}
          value={modelAssignRole}
          onChange={(e) =>
            setModelAssignRole(e.target.value as (typeof LLM_ROLES)[number])
          }
        >
          {LLM_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>

      <div className="split" style={{ marginTop: 12 }}>
        <div className="col">
          <div style={{ fontWeight: 650 }}>Installed</div>
          <div className="events">
            <pre className="mono">
              {safeJson(modelCatalog?.installed ?? [])}
            </pre>
          </div>
        </div>
        <div className="col">
          <div style={{ fontWeight: 650, marginBottom: 8 }}>
            Recommended for this host (RAM-aware)
          </div>
          <div className="list">
            {(modelCatalog?.recommended ?? []).map((m) => {
              const installed = (modelCatalog?.installed ?? []).some(
                (x) => x?.name === m?.name,
              );
              return (
                <div key={m.name} className="item">
                  <div
                    className="row"
                    style={{ justifyContent: "space-between" }}
                  >
                    <div className="mono">{m.name}</div>
                    <span className="badge">
                      {installed ? "installed" : "not installed"}
                    </span>
                  </div>
                  <div className="muted">
                    {m.notes ?? ""}
                    {typeof m.approxQ4RamGiB === "number"
                      ? ` · ~${m.approxQ4RamGiB} GiB Q4 (approx.)`
                      : ""}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || installed}
                      onClick={async () => {
                        setBusy(true);
                        setError(null);
                        try {
                          await command("model_pull", {
                            host: llmPolicy.ollamaHost,
                            modelName: m.name ?? "",
                          });
                          await refreshModelCatalog();
                        } catch (e: unknown) {
                          const err = e as { message?: unknown };
                          setError(
                            typeof err?.message === "string"
                              ? err.message
                              : String(e),
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Pull
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        updateLlmRole(modelAssignRole, {
                          model: m.name ?? "",
                        })
                      }
                    >
                      Use for verify
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
