export type RunRow = {
  id: string;
  created_at: string;
  target_base_url: string;
  policy_name?: string | null;
  llm_provider?: string | null;
  llm_model?: string | null;
  status?: string | null;
  confidence?: number | null;
  summary_md_path?: string | null;
  report_json_path?: string | null;
  parent_run_id?: string | null;
  restart_from_phase?: string | null;
};

export type RunGraph = {
  run: RunRow;
  probes: unknown[];
  toolCalls: unknown[];
  artifacts: unknown[];
  requirements: unknown[];
};

export type RunEvent = { type: string; [k: string]: unknown };

export type McpServerConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export async function listRuns(limit = 50) {
  return await j<{ runs: RunRow[] }>(await fetch(`/api/runs?limit=${limit}`));
}

export async function getRun(runId: string) {
  return await j<RunGraph>(
    await fetch(`/api/runs/${encodeURIComponent(runId)}`),
  );
}

export async function command(name: string, payload: unknown) {
  return await j<unknown>(
    await fetch(`/api/commands/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    }),
  );
}

export async function getChromeDevtoolsMcpConfig() {
  return await j<{ ok: boolean; server: McpServerConfig | null }>(
    await fetch("/api/mcp/chrome-devtools"),
  );
}

export async function getProjectConfig() {
  return await j<{ ok: boolean; path: string | null; config: unknown | null }>(
    await fetch("/api/project-config"),
  );
}

export function subscribeRunEvents(
  runId: string,
  onEvent: (e: RunEvent) => void,
) {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  es.addEventListener("message", (ev) => {
    try {
      onEvent(JSON.parse((ev as MessageEvent).data));
    } catch {
      // ignore malformed events
    }
  });
  return () => es.close();
}
