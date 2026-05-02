import type { Db } from "../db.js";

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

export function insertRun(db: Db, row: RunRow) {
  const stmt = db.prepare(`
    INSERT INTO runs (
      id, created_at, target_base_url, policy_name, llm_provider, llm_model, status, confidence, summary_md_path, report_json_path,
      parent_run_id, restart_from_phase
    ) VALUES (
      @id, @created_at, @target_base_url, @policy_name, @llm_provider, @llm_model, @status, @confidence, @summary_md_path, @report_json_path,
      @parent_run_id, @restart_from_phase
    )
  `);
  stmt.run({
    ...row,
    parent_run_id: row.parent_run_id ?? null,
    restart_from_phase: row.restart_from_phase ?? null,
  });
}

export function insertRunIfMissing(db: Db, row: RunRow): boolean {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO runs (
      id, created_at, target_base_url, policy_name, llm_provider, llm_model, status, confidence, summary_md_path, report_json_path,
      parent_run_id, restart_from_phase
    ) VALUES (
      @id, @created_at, @target_base_url, @policy_name, @llm_provider, @llm_model, @status, @confidence, @summary_md_path, @report_json_path,
      @parent_run_id, @restart_from_phase
    )
  `);
  const info = stmt.run({
    ...row,
    parent_run_id: row.parent_run_id ?? null,
    restart_from_phase: row.restart_from_phase ?? null,
  }) as { changes?: number };
  return (info?.changes ?? 0) > 0;
}

/** Set restart lineage (e.g. when dashboard pre-inserted the run without these fields). */
export function updateRunLineage(
  db: Db,
  runId: string,
  patch: { parent_run_id?: string | null; restart_from_phase?: string | null },
) {
  const stmt = db.prepare(`
    UPDATE runs
    SET parent_run_id = COALESCE(@parent_run_id, parent_run_id),
        restart_from_phase = COALESCE(@restart_from_phase, restart_from_phase)
    WHERE id = @runId
  `);
  stmt.run({
    runId,
    parent_run_id: patch.parent_run_id ?? null,
    restart_from_phase: patch.restart_from_phase ?? null,
  });
}

export function updateRunStatus(
  db: Db,
  runId: string,
  status: string,
  confidence?: number,
) {
  const stmt = db.prepare(`
    UPDATE runs
    SET status = @status,
        confidence = COALESCE(@confidence, confidence)
    WHERE id = @runId
  `);
  stmt.run({ runId, status, confidence: confidence ?? null });
}

export function getRun(db: Db, runId: string): RunRow | undefined {
  const stmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  return stmt.get(runId) as RunRow | undefined;
}

export function listRuns(db: Db, opts?: { limit?: number }): RunRow[] {
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 50));
  const stmt = db.prepare(
    `SELECT * FROM runs ORDER BY created_at DESC LIMIT ${limit}`,
  );
  return stmt.all() as RunRow[];
}
