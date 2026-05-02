import { type ChildProcess, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { checkOllamaRunning } from "../llm/modelOps.js";
import type { OpsContext } from "./context.js";

let proc: ChildProcess | null = null;
let startedAt: string | null = null;

function getOllamaServePid(): number | null {
  // Prefer identifying the listener on the Ollama default port.
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", "-iTCP:11434", "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    ).trim();
    if (out) {
      const pid = Number.parseInt(out.split("\n")[0]!.trim(), 10);
      if (Number.isFinite(pid)) return pid;
    }
  } catch {
    // ignore
  }

  // Fallback: find "ollama serve" by argv (best effort).
  try {
    const out = execFileSync("pgrep", ["-fl", "^ollama serve$"], {
      encoding: "utf8",
    }).trim();
    if (out) {
      const pid = Number.parseInt(out.split(/\s+/)[0]!, 10);
      if (Number.isFinite(pid)) return pid;
    }
  } catch {
    // ignore
  }

  return null;
}

function tryKillPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function ollamaDaemonStatus(_ctx: OpsContext) {
  return {
    running: Boolean(proc && proc.exitCode == null),
    pid: proc?.pid ?? null,
    startedAt,
  };
}

export async function ollamaDaemonStart(
  _ctx: OpsContext,
  input?: { host?: string },
) {
  // If Ollama already reachable, treat as started.
  const host = input?.host ?? "http://127.0.0.1:11434";
  const status = await checkOllamaRunning(host);
  if (status.ok) {
    return { ok: true, alreadyRunning: true, pid: getOllamaServePid() };
  }

  if (proc && proc.exitCode == null) {
    return { ok: true, alreadyRunning: true, pid: proc.pid ?? null };
  }

  proc = spawn("ollama", ["serve"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  startedAt = new Date().toISOString();

  // Give it a moment to bind port; don’t hard fail if it’s slow.
  await new Promise((r) => setTimeout(r, 800));
  return { ok: true, alreadyRunning: false, pid: proc?.pid ?? null };
}

export async function ollamaDaemonStop(_ctx: OpsContext) {
  // If this process didn't start Ollama, attempt to stop the externally
  // running daemon (best effort) by resolving the listener PID.
  if (!proc || proc.exitCode != null) {
    const pid = getOllamaServePid();
    if (pid != null) {
      tryKillPid(pid, "SIGTERM");
      // Give it a moment to shut down, then verify by reachability.
      await new Promise((r) => setTimeout(r, 300));
      const status = await checkOllamaRunning("http://127.0.0.1:11434");
      proc = null;
      startedAt = null;
      return { ok: true, stopped: !status.ok };
    }

    proc = null;
    startedAt = null;
    return { ok: true, stopped: false };
  }
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  const stopped = proc.exitCode != null;
  proc = null;
  startedAt = null;
  return { ok: true, stopped };
}
