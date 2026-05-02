import type { Db } from "../db.js";

export type ToolCallRow = {
  id: string;
  run_id: string;
  probe_id?: string | null;
  capability: string;
  action: string;
  started_at: string;
  ended_at?: string | null;
  ok: number;
  error_code?: string | null;
  error_message?: string | null;
  output_artifact_id?: string | null;
};

export function insertToolCalls(db: Db, rows: ToolCallRow[]) {
  const stmt = db.prepare(`
    INSERT INTO tool_calls (
      id, run_id, probe_id, capability, action,
      started_at, ended_at, ok, error_code, error_message, output_artifact_id
    ) VALUES (
      @id, @run_id, @probe_id, @capability, @action,
      @started_at, @ended_at, @ok, @error_code, @error_message, @output_artifact_id
    )
  `);
  const tx = db.transaction((rs: ToolCallRow[]) => {
    for (const r of rs)
      stmt.run({
        ...r,
        probe_id: r.probe_id ?? null,
        ended_at: r.ended_at ?? null,
        error_code: r.error_code ?? null,
        error_message: r.error_message ?? null,
        output_artifact_id: r.output_artifact_id ?? null,
      });
  });
  tx(rows);
}

export function listToolCalls(db: Db, runId: string): ToolCallRow[] {
  const stmt = db.prepare(
    `SELECT * FROM tool_calls WHERE run_id = ? ORDER BY started_at ASC`,
  );
  return stmt.all(runId) as ToolCallRow[];
}
