import type { LlmRoleProvider } from "../../../../src/llm/types.js";
import { useDashboard } from "../../context/DashboardContext";
import { LLM_ROLES, ROLE_LABELS } from "../../lib/llmUi";

export function LlmPolicyCard() {
  const {
    llmPolicy,
    setLlmPolicy,
    modelCatalog,
    updateLlmRole,
    availableOllamaModels,
  } = useDashboard();

  return (
    <div className="card col" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 650 }}>LLM policy</div>
      <div className="muted" style={{ marginBottom: 10 }}>
        Per-role providers and models (matches{" "}
        <code className="mono">checkirai.config.json</code> ·{" "}
        <code className="mono">LlmPolicy</code>). Sent on each verify; the API
        merges hardware <code className="mono">profiles</code> from the project
        file when <code className="mono">defaults.profile</code> is set.
      </div>

      <label className="muted" htmlFor="ollamaHost">
        Ollama host
      </label>
      <input
        id="ollamaHost"
        className="input"
        value={llmPolicy.ollamaHost}
        onChange={(e) =>
          setLlmPolicy((p) => ({ ...p, ollamaHost: e.target.value }))
        }
      />

      <label className="row" style={{ marginTop: 8, gap: 8 }}>
        <input
          type="checkbox"
          checked={llmPolicy.allowAutoPull}
          onChange={(e) =>
            setLlmPolicy((p) => ({
              ...p,
              allowAutoPull: e.target.checked,
            }))
          }
        />
        <span className="muted">Allow auto-pull (Ollama)</span>
      </label>
      <label className="row" style={{ marginTop: 4, gap: 8 }}>
        <input
          type="checkbox"
          checked={llmPolicy.requireToolCapable}
          onChange={(e) =>
            setLlmPolicy((p) => ({
              ...p,
              requireToolCapable: e.target.checked,
            }))
          }
        />
        <span className="muted">Require tool-capable models (catalog)</span>
      </label>

      <div className="muted" style={{ marginTop: 10 }}>
        Ollama:{" "}
        <span className="mono">
          {modelCatalog?.ollama?.ok
            ? `ok (v${modelCatalog?.ollama?.version ?? "?"})`
            : "not running"}
        </span>
      </div>

      {LLM_ROLES.map((role) => {
        const rc = llmPolicy[role];
        return (
          <div
            key={role}
            className="col"
            style={{
              marginTop: 12,
              paddingTop: 10,
              borderTop: "1px solid #334155",
            }}
          >
            <div style={{ fontWeight: 650, marginBottom: 6 }}>
              {ROLE_LABELS[role]}
            </div>
            <label className="muted" htmlFor={`${role}-provider`}>
              Provider
            </label>
            <select
              id={`${role}-provider`}
              className="select"
              value={rc.provider}
              onChange={(e) =>
                updateLlmRole(role, {
                  provider: e.target.value as LlmRoleProvider,
                })
              }
            >
              <option value="ollama">ollama</option>
              <option value="remote">remote</option>
              <option value="none">none</option>
            </select>

            {rc.provider === "remote" ? (
              <>
                <label className="muted" htmlFor={`${role}-remoteUrl`}>
                  Remote base URL
                </label>
                <input
                  id={`${role}-remoteUrl`}
                  className="input"
                  placeholder="https://api.example.com/v1"
                  value={rc.remoteBaseUrl ?? ""}
                  onChange={(e) =>
                    updateLlmRole(role, {
                      remoteBaseUrl: e.target.value || undefined,
                    })
                  }
                />
              </>
            ) : null}

            <label className="muted" htmlFor={`${role}-model`}>
              Model
            </label>
            {rc.provider === "ollama" ? (
              <select
                id={`${role}-model`}
                className="select"
                value={rc.model}
                onChange={(e) => updateLlmRole(role, { model: e.target.value })}
              >
                {availableOllamaModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${role}-model`}
                className="input mono"
                value={rc.model}
                onChange={(e) => updateLlmRole(role, { model: e.target.value })}
              />
            )}

            {rc.provider === "ollama" ? (
              <>
                <label className="muted" htmlFor={`${role}-fb`}>
                  Fallback model (optional)
                </label>
                <select
                  id={`${role}-fb`}
                  className="select"
                  value={rc.fallbackModel ?? ""}
                  onChange={(e) =>
                    updateLlmRole(role, {
                      fallbackModel: e.target.value.trim()
                        ? e.target.value.trim()
                        : undefined,
                    })
                  }
                >
                  <option value="">(none)</option>
                  {availableOllamaModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </>
            ) : null}

            <label className="muted" htmlFor={`${role}-temp`}>
              Temperature
            </label>
            <input
              id={`${role}-temp`}
              className="input"
              type="number"
              step="0.1"
              value={rc.temperature ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                updateLlmRole(
                  role,
                  v === ""
                    ? { temperature: undefined }
                    : { temperature: Number(v) },
                );
              }}
            />

            <label className="muted" htmlFor={`${role}-retries`}>
              Max retries (optional)
            </label>
            <input
              id={`${role}-retries`}
              className="input"
              type="number"
              min={0}
              step={1}
              value={rc.maxRetries ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                updateLlmRole(
                  role,
                  v === ""
                    ? { maxRetries: undefined }
                    : { maxRetries: Math.max(0, Math.floor(Number(v))) },
                );
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
