import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type LlmPolicy, LlmPolicySchema } from "../../../src/llm/types.js";
import {
  command,
  getChromeDevtoolsMcpConfig,
  getDartMcpConfig,
  getProjectConfig,
  type RunRow,
} from "../api";
import { buildVerifyMcpExtras } from "../lib/verifyPayload";
import type { RestartPhase, TimelineItem } from "../types/dashboard";

type LogFn = (item: Omit<TimelineItem, "ts"> & { ts?: string }) => void;
type RespondFn = (title: string, body: unknown) => void;

export function useVerifyForm(options: {
  log: LogFn;
  respond: RespondFn;
  selectedRunId: string | null;
  selectedRun: RunRow | null;
  refreshRuns: () => Promise<void>;
  setSelectedRunId: (id: string) => void;
  llmPolicy: LlmPolicy;
  setLlmPolicy: Dispatch<SetStateAction<LlmPolicy>>;
  llmRunSummary: { llm_provider?: string | null; llm_model?: string | null };
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
}) {
  const {
    log,
    respond,
    selectedRunId,
    selectedRun,
    refreshRuns,
    setSelectedRunId,
    llmPolicy,
    setLlmPolicy,
    llmRunSummary,
    busy,
    setBusy,
    error,
    setError,
  } = options;
  const [targetUrl, setTargetUrl] = useState("http://localhost:5173");
  const [tools, setTools] = useState("fs,http,playwright-mcp,chrome-devtools");
  const [chromeDevtoolsCommand, setChromeDevtoolsCommand] = useState("");
  const [chromeDevtoolsArgs, setChromeDevtoolsArgs] = useState("");
  const [chromeDevtoolsCwd, setChromeDevtoolsCwd] = useState("");
  const [dartMcpCommand, setDartMcpCommand] = useState("");
  const [dartMcpArgs, setDartMcpArgs] = useState("");
  const [dartMcpCwd, setDartMcpCwd] = useState("");
  const [dartProjectRoot, setDartProjectRoot] = useState("");
  const [dartDriverDevice, setDartDriverDevice] = useState("");
  const [specMarkdown, setSpecMarkdown] = useState(
    "- The page has a “Sign in” button",
  );
  const [projectFileProfile, setProjectFileProfile] = useState<string | null>(
    null,
  );
  const [projectProfileNames, setProjectProfileNames] = useState<string[]>([]);
  const [specDropActive, setSpecDropActive] = useState(false);
  const [restartPhase, setRestartPhase] = useState<RestartPhase>("llm_plan");

  const wantsChromeDevtools = useMemo(
    () =>
      tools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes("chrome-devtools"),
    [tools],
  );

  const wantsDartMcp = useMemo(
    () =>
      tools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes("dart-mcp"),
    [tools],
  );

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
        const rawLlm =
          cfg && typeof cfg === "object" && "llm" in cfg
            ? (cfg as { llm?: unknown }).llm
            : undefined;
        if (rawLlm !== undefined) {
          const parsed = LlmPolicySchema.safeParse(rawLlm);
          if (parsed.success) setLlmPolicy(parsed.data);
        }
        if (cfg && typeof cfg === "object" && "profiles" in cfg) {
          const pr = (cfg as { profiles?: unknown }).profiles;
          if (pr && typeof pr === "object" && !Array.isArray(pr)) {
            setProjectProfileNames(Object.keys(pr as Record<string, unknown>));
          } else {
            setProjectProfileNames([]);
          }
        } else {
          setProjectProfileNames([]);
        }
        const defProfile =
          defaults && typeof defaults === "object" && "profile" in defaults
            ? (defaults as { profile?: unknown }).profile
            : null;
        setProjectFileProfile(
          typeof defProfile === "string" && defProfile.trim()
            ? defProfile.trim()
            : null,
        );
      })
      .catch(() => {});
  }, [setLlmPolicy]);

  useEffect(() => {
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
    getDartMcpConfig()
      .then((out) => {
        if (!out?.ok || !out.server) return;
        if (!dartMcpCommand) setDartMcpCommand(out.server.command);
        if (!dartMcpArgs && out.server.args?.length)
          setDartMcpArgs(out.server.args.join(" "));
        if (!dartMcpCwd && out.server.cwd) setDartMcpCwd(out.server.cwd);
      })
      .catch(() => {});
  }, [dartMcpArgs, dartMcpCommand, dartMcpCwd]);

  const loadSpecFile = useCallback(async (file: File) => {
    const text = await file.text();
    setSpecMarkdown(text);
  }, []);

  const mcpExtras = useCallback(
    () =>
      buildVerifyMcpExtras({
        wantsChromeDevtools,
        chromeDevtools: {
          command: chromeDevtoolsCommand,
          args: chromeDevtoolsArgs,
          cwd: chromeDevtoolsCwd,
        },
        wantsDartMcp,
        dartMcp: {
          command: dartMcpCommand,
          args: dartMcpArgs,
          cwd: dartMcpCwd,
        },
        dart: { dartProjectRoot, dartDriverDevice },
      }),
    [
      wantsChromeDevtools,
      chromeDevtoolsCommand,
      chromeDevtoolsArgs,
      chromeDevtoolsCwd,
      wantsDartMcp,
      dartMcpCommand,
      dartMcpArgs,
      dartMcpCwd,
      dartProjectRoot,
      dartDriverDevice,
    ],
  );

  const validateMcpCommands = useCallback(
    (forRestart = false) => {
      if (wantsChromeDevtools && !chromeDevtoolsCommand.trim()) {
        const msg = forRestart
          ? "chrome-devtools is enabled, but chromeDevtoolsServer.command is empty. Fill it in on the MCP tab."
          : "chrome-devtools is enabled, but chromeDevtoolsServer.command is empty. Fill it in (e.g. use the same command you pass to `checkirai chrome-devtools self-check --command ...`).";
        setError(msg);
        log({
          level: "error",
          title: "Blocked: missing Chrome DevTools MCP command",
          body: msg,
          source: "client",
        });
        return false;
      }
      if (wantsDartMcp && !dartMcpCommand.trim()) {
        const msg =
          "dart-mcp is enabled, but dartMcpServer.command is empty. Fill it in on the MCP tab.";
        setError(msg);
        log({
          level: "error",
          title: "Blocked: missing Dart MCP command",
          body: msg,
          source: "client",
        });
        return false;
      }
      return true;
    },
    [
      wantsChromeDevtools,
      chromeDevtoolsCommand,
      wantsDartMcp,
      dartMcpCommand,
      log,
      setError,
    ],
  );

  const runVerify = useCallback(async () => {
    setBusy(true);
    setError(null);
    log({
      level: "info",
      title: "Run clicked: verify_spec",
      body: {
        targetUrl,
        tools,
        llm: llmRunSummary,
      },
      source: "client",
      runId: selectedRunId,
    });
    try {
      if (!validateMcpCommands()) return;
      const llm = LlmPolicySchema.parse(llmPolicy);
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
        ...mcpExtras(),
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
  }, [
    targetUrl,
    tools,
    llmRunSummary,
    selectedRunId,
    validateMcpCommands,
    llmPolicy,
    specMarkdown,
    mcpExtras,
    log,
    respond,
    setSelectedRunId,
    refreshRuns,
    setBusy,
    setError,
  ]);

  const rerunFromPhase = useCallback(async () => {
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
      if (!validateMcpCommands(true)) return;
      const llm = LlmPolicySchema.parse(llmPolicy);
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
        ...mcpExtras(),
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
  }, [
    selectedRun,
    restartPhase,
    runVerify,
    log,
    validateMcpCommands,
    llmPolicy,
    targetUrl,
    tools,
    mcpExtras,
    respond,
    setSelectedRunId,
    refreshRuns,
    setError,
    setBusy,
  ]);

  return {
    busy,
    setBusy,
    error,
    setError,
    targetUrl,
    setTargetUrl,
    tools,
    setTools,
    chromeDevtoolsCommand,
    setChromeDevtoolsCommand,
    chromeDevtoolsArgs,
    setChromeDevtoolsArgs,
    chromeDevtoolsCwd,
    setChromeDevtoolsCwd,
    dartMcpCommand,
    setDartMcpCommand,
    dartMcpArgs,
    setDartMcpArgs,
    dartMcpCwd,
    setDartMcpCwd,
    dartProjectRoot,
    setDartProjectRoot,
    dartDriverDevice,
    setDartDriverDevice,
    specMarkdown,
    setSpecMarkdown,
    projectFileProfile,
    projectProfileNames,
    specDropActive,
    setSpecDropActive,
    restartPhase,
    setRestartPhase,
    wantsChromeDevtools,
    wantsDartMcp,
    loadSpecFile,
    runVerify,
    rerunFromPhase,
  };
}
