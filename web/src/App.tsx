import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  command,
  getChromeDevtoolsMcpConfig,
  getProjectConfig,
  getRun,
  listRuns,
  type RunEvent,
  type RunGraph,
  type RunRow,
  subscribeRunEvents,
} from "./api";
import React from "react";

function fmt(ts?: string | null) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function App() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runGraph, setRunGraph] = useState<RunGraph | null>(null);
  const [events, setEvents] = useState<
    Array<RunEvent & { _receivedAt: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"general" | "mcp" | "ollama">("general");
  const [inputSpecIrByRunId, setInputSpecIrByRunId] = useState<
    Record<string, unknown>
  >({});
  const [llmCallsByRunId, setLlmCallsByRunId] = useState<
    Record<
      string,
      Array<{
        ts: string;
        phase?: unknown;
        provider?: unknown;
        host?: unknown;
        model?: unknown;
        durationMs?: unknown;
        promptChars?: unknown;
        responseChars?: unknown;
        truncated?: unknown;
        system?: unknown;
        prompt?: unknown;
        responseText?: unknown;
      }>
    >
  >({});
  type ModelCatalog = {
    ollama?: { ok?: boolean; version?: string };
    installed?: Array<{ name?: unknown }>;
    recommended?: Array<{ name?: string; notes?: string }>;
  };
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);

  // Verify form
  const [targetUrl, setTargetUrl] = useState("http://localhost:5173");
  const [tools, setTools] = useState("fs,http,playwright-mcp,chrome-devtools");
  const [chromeDevtoolsCommand, setChromeDevtoolsCommand] = useState("");
  const [chromeDevtoolsArgs, setChromeDevtoolsArgs] = useState("");
  const [chromeDevtoolsCwd, setChromeDevtoolsCwd] = useState("");
  const [specMarkdown, setSpecMarkdown] = useState(
    "- The page has a “Sign in” button",
  );
  const [llmProvider, setLlmProvider] = useState("ollama");
  const [ollamaHost, setOllamaHost] = useState("http://127.0.0.1:11434");
  const [ollamaModel, setOllamaModel] = useState("auto");
  const [specDropActive, setSpecDropActive] = useState(false);
  const [lastResponse, setLastResponse] = useState<{
    title: string;
    body: unknown;
    ts: string;
  } | null>(null);
  const [restartPhase, setRestartPhase] = useState<
    "start" | "spec_ir" | "llm_plan"
  >("llm_plan");

  type TimelineItem = {
    ts: string;
    level: "info" | "success" | "warn" | "error";
    title: string;
    body?: unknown;
    source: "client" | "backend";
    runId?: string | null;
  };
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const log = useCallback(
    (item: Omit<TimelineItem, "ts"> & { ts?: string }) => {
      const ts = item.ts ?? new Date().toISOString();
      setTimeline((prev) => {
        const next = prev.length > 900 ? prev.slice(prev.length - 900) : prev;
        return [...next, { ts, ...item }];
      });
    },
    [],
  );

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const wantsChromeDevtools = useMemo(
    () =>
      tools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes("chrome-devtools"),
    [tools],
  );

  const refreshRuns = useCallback(async () => {
    const out = await listRuns(80);
    setRuns(out.runs);
    if (!selectedRunId && out.runs[0]?.id) setSelectedRunId(out.runs[0].id);
  }, [selectedRunId]);

  useEffect(() => {
    refreshRuns().catch((e) => setError(String(e?.message ?? e)));
    const t = setInterval(() => refreshRuns().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [refreshRuns]);

  useEffect(() => {
    getProjectConfig()
      .then((out) => {
        const cfg =
          out && typeof out === "object" && out && "config" in out
            ? (out as { config?: unknown }).config
            : null;
        const defaults =
          cfg && typeof cfg === "object" && "defaults" in cfg
            ? (cfg as { defaults?: unknown }).defaults
            : null;
        if (defaults && typeof defaults === "object") {
          const d = defaults as Record<string, unknown>;
          if (typeof d.targetUrl === "string") setTargetUrl(d.targetUrl);
          if (typeof d.tools === "string") setTools(d.tools);
        }
        const llm =
          cfg && typeof cfg === "object" && "llm" in cfg
            ? (cfg as { llm?: unknown }).llm
            : null;
        if (llm && typeof llm === "object") {
          const p = llm as Record<string, unknown>;
          if (typeof p.provider === "string") setLlmProvider(p.provider);
          if (typeof p.ollamaHost === "string") setOllamaHost(p.ollamaHost);
          if (typeof p.ollamaModel === "string") setOllamaModel(p.ollamaModel);
        }
      })
      .catch(() => {});
    // Run once on mount; config is static in practice.
  }, []);

  useEffect(() => {
    // Auto-populate Chrome DevTools MCP config from Cursor's ~/.cursor/mcp.json
    // via the backend, but don't overwrite if the user already typed something.
    getChromeDevtoolsMcpConfig()
      .then((out) => {
        if (!out?.ok || !out.server) return;
        if (!chromeDevtoolsCommand)
          setChromeDevtoolsCommand(out.server.command);
        if (!chromeDevtoolsArgs && out.server.args?.length)
          setChromeDevtoolsArgs(out.server.args.join(" "));
        if (!chromeDevtoolsCwd && out.server.cwd)
          setChromeDevtoolsCwd(out.server.cwd);
      })
      .catch(() => {});
  }, [chromeDevtoolsArgs, chromeDevtoolsCommand, chromeDevtoolsCwd]);

  useEffect(() => {
    if (!selectedRunId) return;
    let unsub = () => {};

    setEvents([]);
    log({
      level: "info",
      title: `Selected run ${selectedRunId}`,
      source: "client",
      runId: selectedRunId,
    });
    getRun(selectedRunId)
      .then((g) => setRunGraph(g))
      .catch((e) => setError(String(e?.message ?? e)));

    unsub = subscribeRunEvents(selectedRunId, (e) => {
      const receivedAt = new Date().toISOString();
      setEvents((prev) => {
        const next = prev.length > 300 ? prev.slice(prev.length - 300) : prev;
        return [...next, { ...e, _receivedAt: receivedAt }];
      });
      log({
        level: "info",
        title: `event: ${String(e?.type ?? "message")}`,
        body: e,
        source: "backend",
        runId: selectedRunId,
        ts: receivedAt,
      });

      // Backend is the source of truth for spec IR; it publishes it on run start.
      if (e?.type === "run_started") {
        const meta =
          e && typeof e === "object" && "meta" in e
            ? (e as { meta?: unknown }).meta
            : null;
        const specIr =
          meta && typeof meta === "object" && meta && "specIr" in meta
            ? (meta as { specIr?: unknown }).specIr
            : null;
        if (specIr != null) {
          setInputSpecIrByRunId((prev) => ({
            ...prev,
            [selectedRunId]: specIr,
          }));
        }
      }

      if (e?.type === "llm_call") {
        setLlmCallsByRunId((prev) => {
          const cur = prev[selectedRunId] ?? [];
          const next = cur.length > 80 ? cur.slice(cur.length - 80) : cur;
          return {
            ...prev,
            [selectedRunId]: [
              ...next,
              {
                ts: receivedAt,
                phase: (e as any).phase,
                provider: (e as any).provider,
                host: (e as any).host,
                model: (e as any).model,
                durationMs: (e as any).durationMs,
                promptChars: (e as any).promptChars,
                responseChars: (e as any).responseChars,
                truncated: (e as any).truncated,
                system: (e as any).system,
                prompt: (e as any).prompt,
                responseText: (e as any).responseText,
              },
            ],
          };
        });
      }

      if (e?.type === "run_error") {
        const msg =
          e && typeof e === "object" && "message" in e
            ? String((e as any).message ?? "")
            : "run_error";
        if (msg) setError(msg);
      }
    });

    const poll = setInterval(() => {
      getRun(selectedRunId)
        .then((g) => setRunGraph(g))
        .catch(() => {});
    }, 2500);

    return () => {
      unsub();
      clearInterval(poll);
    };
  }, [selectedRunId]);

  const refreshModelCatalog = useCallback(async () => {
    const out = await command("model_catalog", {
      host: ollamaHost,
      requireTooling: true,
    });
    setModelCatalog(out as ModelCatalog);
  }, [ollamaHost]);

  useEffect(() => {
    refreshModelCatalog().catch(() => {});
  }, [refreshModelCatalog]);

  const availableOllamaModels = useMemo(() => {
    const installed = (modelCatalog?.installed ?? [])
      .map((m) => (typeof m?.name === "string" ? m.name : null))
      .filter(Boolean) as string[];
    const recommended = (modelCatalog?.recommended ?? [])
      .map((m) => (typeof m?.name === "string" ? m.name : null))
      .filter(Boolean) as string[];
    const all = Array.from(new Set(["auto", ...installed, ...recommended]));
    if (ollamaModel && !all.includes(ollamaModel)) all.push(ollamaModel);
    return all;
  }, [modelCatalog, ollamaModel]);

  const respond = useCallback((title: string, body: unknown) => {
    setLastResponse({ title, body, ts: new Date().toISOString() });
  }, []);

  const loadSpecFile = useCallback(async (file: File) => {
    const text = await file.text();
    setSpecMarkdown(text);
  }, []);

  async function runVerify() {
    setBusy(true);
    setError(null);
    log({
      level: "info",
      title: "Run clicked: verify_spec",
      body: {
        targetUrl,
        tools,
        llmProvider,
        ollamaHost: llmProvider === "ollama" ? ollamaHost : undefined,
        ollamaModel: llmProvider === "ollama" ? ollamaModel : undefined,
      },
      source: "client",
      runId: selectedRunId,
    });
    try {
      if (wantsChromeDevtools && !chromeDevtoolsCommand.trim()) {
        const msg =
          "chrome-devtools is enabled, but chromeDevtoolsServer.command is empty. Fill it in (e.g. use the same command you pass to `checkirai chrome-devtools self-check --command ...`).";
        setError(msg);
        log({
          level: "error",
          title: "Blocked: missing Chrome DevTools MCP command",
          body: msg,
          source: "client",
        });
        return;
      }
      const llm =
        llmProvider === "ollama"
          ? {
              provider: "ollama",
              ollamaHost,
              ollamaModel,
              allowAutoPull: true,
            }
          : { provider: llmProvider };
      const startedAt = performance.now();
      log({
        level: "info",
        title: "Request started: /api/commands/verify_spec",
        source: "client",
      });
      const out = await command("verify_spec", {
        targetUrl,
        tools,
        specMarkdown,
        llm,
        ...(wantsChromeDevtools
          ? {
              chromeDevtoolsServer: {
                command: chromeDevtoolsCommand.trim(),
                ...(chromeDevtoolsArgs.trim()
                  ? {
                      args: chromeDevtoolsArgs
                        .split(" ")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : {}),
                ...(chromeDevtoolsCwd.trim()
                  ? { cwd: chromeDevtoolsCwd.trim() }
                  : {}),
              },
            }
          : {}),
      });
      const durMs = Math.max(0, performance.now() - startedAt);
      log({
        level: "success",
        title: `Request finished: verify_spec (${durMs.toFixed(0)}ms)`,
        body: out,
        source: "client",
      });
      respond("verify_spec", out);
      const runId =
        out && typeof out === "object" && "runId" in out
          ? (out as { runId?: unknown }).runId
          : null;
      if (typeof runId === "string") {
        log({
          level: "success",
          title: `Run created: ${runId}`,
          source: "client",
          runId,
        });
        setSelectedRunId(runId);
      } else {
        log({
          level: "warn",
          title: "verify_spec returned no runId",
          body: out,
          source: "client",
        });
      }
      await refreshRuns();
    } catch (e: unknown) {
      const err = e as { message?: unknown };
      const msg = typeof err?.message === "string" ? err.message : String(e);
      setError(msg);
      log({
        level: "error",
        title: "verify_spec failed",
        body: msg,
        source: "client",
      });
    } finally {
      setBusy(false);
    }
  }

  async function rerunFromPhase() {
    if (!selectedRun) return;
    if (restartPhase === "start") {
      await runVerify();
      return;
    }
    setBusy(true);
    setError(null);
    log({
      level: "info",
      title: `Run clicked: restart from ${restartPhase}`,
      body: { parentRunId: selectedRun.id, restartPhase },
      source: "client",
      runId: selectedRun.id,
    });
    try {
      if (wantsChromeDevtools && !chromeDevtoolsCommand.trim()) {
        const msg =
          "chrome-devtools is enabled, but chromeDevtoolsServer.command is empty. Fill it in on the MCP tab.";
        setError(msg);
        log({
          level: "error",
          title: "Blocked: missing Chrome DevTools MCP command",
          body: msg,
          source: "client",
        });
        return;
      }

      const llm =
        llmProvider === "ollama"
          ? {
              provider: "ollama",
              ollamaHost,
              ollamaModel,
              allowAutoPull: true,
            }
          : { provider: llmProvider };

      const startedAt = performance.now();
      log({
        level: "info",
        title: "Request started: /api/commands/verify_spec (restart)",
        source: "client",
      });
      const out = await command("verify_spec", {
        targetUrl: selectedRun.target_base_url || targetUrl,
        tools,
        llm,
        restartFromPhase: restartPhase,
        restartFromRunId: selectedRun.id,
        ...(wantsChromeDevtools
          ? {
              chromeDevtoolsServer: {
                command: chromeDevtoolsCommand.trim(),
                ...(chromeDevtoolsArgs.trim()
                  ? {
                      args: chromeDevtoolsArgs
                        .split(" ")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : {}),
                ...(chromeDevtoolsCwd.trim()
                  ? { cwd: chromeDevtoolsCwd.trim() }
                  : {}),
              },
            }
          : {}),
      });
      const durMs = Math.max(0, performance.now() - startedAt);
      log({
        level: "success",
        title: `Request finished: verify_spec restart (${durMs.toFixed(0)}ms)`,
        body: out,
        source: "client",
      });
      respond("verify_spec restart", out);
      const runId =
        out && typeof out === "object" && "runId" in out
          ? (out as { runId?: unknown }).runId
          : null;
      if (typeof runId === "string") setSelectedRunId(runId);
      await refreshRuns();
    } catch (e: unknown) {
      const err = e as { message?: unknown };
      const msg = typeof err?.message === "string" ? err.message : String(e);
      setError(msg);
      log({
        level: "error",
        title: "verify_spec restart failed",
        body: msg,
        source: "client",
      });
    } finally {
      setBusy(false);
    }
  }

  const timelineForSelectedRun = useMemo(() => {
    const rid = selectedRunId;
    const items = rid
      ? timeline.filter((t) => (t.runId ?? null) === rid)
      : timeline;
    return items.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  }, [selectedRunId, timeline]);

  useEffect(() => {
    // auto-scroll timeline to latest when busy or when new items arrive
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [timelineForSelectedRun.length, busy]);

  return (
    <div className="layout">
      <div className="sidebar">
        <div className="h1">checkirai dashboard</div>

        <div className="tabs" role="tablist" aria-label="Sidebar views">
          <button
            type="button"
            role="tab"
            aria-selected={view === "general"}
            className={`tab ${view === "general" ? "tabActive" : ""}`}
            onClick={() => setView("general")}
          >
            General
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "mcp"}
            className={`tab ${view === "mcp" ? "tabActive" : ""}`}
            onClick={() => setView("mcp")}
          >
            MCP
            {wantsChromeDevtools && !chromeDevtoolsCommand.trim() ? (
              <span className="tabDot" title="Needs setup" aria-hidden="true" />
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "ollama"}
            className={`tab ${view === "ollama" ? "tabActive" : ""}`}
            onClick={() => setView("ollama")}
          >
            Ollama
          </button>
        </div>

        {view === "general" ? (
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

            <label className="muted" htmlFor="llmProvider">
              LLM provider
            </label>
            <select
              id="llmProvider"
              className="select"
              value={llmProvider}
              onChange={(e) => setLlmProvider(e.target.value)}
            >
              <option value="ollama">ollama</option>
              <option value="none">none</option>
              <option value="remote">remote</option>
            </select>

            {llmProvider === "ollama" ? (
              <div className="muted">
                Configure host/model in the{" "}
                <button
                  type="button"
                  className="linkBtn"
                  onClick={() => setView("ollama")}
                >
                  Ollama tab
                </button>
                .
              </div>
            ) : null}
          </div>
        ) : null}

        {view === "mcp" ? (
          <div className="card col" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 650 }}>MCP configuration</div>

            <div className="muted">
              This dashboard currently uses MCP for Chrome DevTools when the
              `chrome-devtools` tool is enabled.
            </div>

            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="muted">Chrome DevTools MCP</div>
              {wantsChromeDevtools ? (
                <span className="badge">enabled</span>
              ) : (
                <span className="badge">disabled</span>
              )}
            </div>

            <label className="muted" htmlFor="chromeDevtoolsCommand">
              Command
            </label>
            <input
              id="chromeDevtoolsCommand"
              className="input"
              placeholder="e.g. node path/to/server.js  (whatever launches your MCP server)"
              value={chromeDevtoolsCommand}
              onChange={(e) => setChromeDevtoolsCommand(e.target.value)}
            />

            <label className="muted" htmlFor="chromeDevtoolsArgs">
              Args (space-separated)
            </label>
            <input
              id="chromeDevtoolsArgs"
              className="input"
              placeholder="(optional)"
              value={chromeDevtoolsArgs}
              onChange={(e) => setChromeDevtoolsArgs(e.target.value)}
            />

            <label className="muted" htmlFor="chromeDevtoolsCwd">
              Cwd
            </label>
            <input
              id="chromeDevtoolsCwd"
              className="input"
              placeholder="(optional)"
              value={chromeDevtoolsCwd}
              onChange={(e) => setChromeDevtoolsCwd(e.target.value)}
            />
          </div>
        ) : null}

        {view === "ollama" ? (
          <div className="card col" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 650 }}>Ollama</div>

            <label className="muted" htmlFor="ollamaHost">
              Host
            </label>
            <input
              id="ollamaHost"
              className="input"
              value={ollamaHost}
              onChange={(e) => setOllamaHost(e.target.value)}
            />

            <label className="muted" htmlFor="ollamaModel">
              Model
            </label>
            <select
              id="ollamaModel"
              className="select"
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
            >
              {availableOllamaModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>

            <div className="muted">
              Status:{" "}
              <span className="mono">
                {modelCatalog?.ollama?.ok
                  ? `ok (v${modelCatalog?.ollama?.version ?? "?"})`
                  : "not running"}
              </span>
            </div>
          </div>
        ) : null}

        {view === "general" ? (
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
                    outline:
                      r.id === selectedRunId ? "2px solid #334155" : "none",
                    textAlign: "left",
                  }}
                >
                  <div
                    className="row"
                    style={{ justifyContent: "space-between" }}
                  >
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
        ) : null}
      </div>

      <div className="main">
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
              <span className="badge">
                {selectedRun.status ?? "unknown"}
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
            </div>
          ) : null}
        </div>

        {error ? (
          <div
            className="card"
            style={{ borderColor: "#7f1d1d", marginBottom: 12 }}
          >
            <div style={{ fontWeight: 650, marginBottom: 8 }}>Error</div>
            <div className="mono">{error}</div>
          </div>
        ) : null}

        <div className="split" style={{ marginBottom: 12 }}>
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
                  {timelineForSelectedRun.map((t, idx) => (
                    <div
                      key={`${t.ts}-${idx}`}
                      className={`timelineRow level-${t.level}`}
                    >
                      <div className="timelineMeta">
                        <span className="timelineTs mono">{fmt(t.ts)}</span>
                        <span className="badge">{t.source}</span>
                        <span className="badge">{t.level}</span>
                      </div>
                      <div className="timelineTitle">{t.title}</div>
                      {t.body != null ? (
                        <pre className="mono timelineBody">
                          {safeJson(t.body)}
                        </pre>
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
        </div>

        {selectedRun ? (
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
              Uses cached artifacts from the selected run to skip earlier
              phases.
            </div>
            <label
              className="muted"
              htmlFor="restartPhase"
              style={{ marginTop: 10 }}
            >
              Phase
            </label>
            <select
              id="restartPhase"
              className="select"
              value={restartPhase}
              onChange={(e) =>
                setRestartPhase(
                  e.target.value as "start" | "spec_ir" | "llm_plan",
                )
              }
            >
              <option value="start">start (full rerun)</option>
              <option value="spec_ir">spec_ir (reuse normalized IR)</option>
              <option value="llm_plan">
                llm_plan (reuse IR + cached plan)
              </option>
            </select>
            <div className="muted" style={{ marginTop: 6 }}>
              Note: `llm_plan` requires the cached plan to match the current
              Chrome DevTools MCP tool surface.
            </div>
          </div>
        ) : null}

        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 650, marginBottom: 8 }}>Input Spec IR</div>
          <div className="events" style={{ maxHeight: 340 }}>
            <pre className="mono">
              {selectedRunId && selectedRunId in inputSpecIrByRunId
                ? safeJson(inputSpecIrByRunId[selectedRunId])
                : "Start a run (or keep the tab open) to capture the input IR."}
            </pre>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div style={{ fontWeight: 650 }}>LLM activity</div>
            <div className="muted">
              {selectedRunId && llmCallsByRunId[selectedRunId]?.length
                ? `${llmCallsByRunId[selectedRunId]!.length} call(s)`
                : "No LLM calls yet."}
            </div>
          </div>
          <div className="events" style={{ marginTop: 8, maxHeight: 340 }}>
            <pre className="mono">
              {selectedRunId && llmCallsByRunId[selectedRunId]?.length
                ? safeJson(llmCallsByRunId[selectedRunId]!.slice(-3))
                : "When a local LLM is used, its prompt/response will appear here."}
            </pre>
          </div>
        </div>

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
                    host: ollamaHost,
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
                    host: ollamaHost,
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

        <div className="card" style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div style={{ fontWeight: 650 }}>Ollama models</div>
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
                Recommended (downloadable)
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
                      <div className="muted">{m.notes ?? ""}</div>
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
                                host: ollamaHost,
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
                          onClick={() => setOllamaModel(m.name ?? "")}
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
      </div>
    </div>
  );
}
