import type { RunEvent } from "../api";

export function fmt(ts?: string | null) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export function safeJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function formatLiveStepLabel(e: RunEvent): string | null {
  if (e.type === "step_started") {
    const cap =
      typeof e.capability === "string" ? e.capability : String(e.capability);
    const act = typeof e.action === "string" ? e.action : String(e.action);
    return `${cap} › ${act}`;
  }
  if (e.type === "probe_started") {
    const pid = typeof e.probeId === "string" ? e.probeId.slice(0, 8) : "probe";
    return `Probe ${pid}…`;
  }
  if (e.type === "run_started") return "Starting verification…";
  return null;
}
