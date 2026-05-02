import type { Db } from "../db.js";

export type RequirementRow = {
  run_id: string;
  id: string;
  source_text: string;
  type: string;
  priority: string;
  verdict?: string | null;
  confidence?: number | null;
  judgment_mode?: string | null;
  why_failed_or_blocked?: string | null;
  repair_hint?: string | null;
};

export function insertRequirements(db: Db, rows: RequirementRow[]) {
  const stmt = db.prepare(`
    INSERT INTO requirements (
      id, run_id, source_text, type, priority, verdict, confidence, judgment_mode, why_failed_or_blocked, repair_hint
    ) VALUES (
      @id, @run_id, @source_text, @type, @priority, @verdict, @confidence, @judgment_mode, @why_failed_or_blocked, @repair_hint
    )
  `);
  const tx = db.transaction((rs: RequirementRow[]) => {
    for (const r of rs)
      stmt.run({
        ...r,
        verdict: r.verdict ?? null,
        confidence: r.confidence ?? null,
        judgment_mode: r.judgment_mode ?? null,
        why_failed_or_blocked: r.why_failed_or_blocked ?? null,
        repair_hint: r.repair_hint ?? null,
      });
  });
  tx(rows);
}

export function updateRequirementResult(
  db: Db,
  runId: string,
  requirementId: string,
  patch: Pick<
    RequirementRow,
    | "verdict"
    | "confidence"
    | "judgment_mode"
    | "why_failed_or_blocked"
    | "repair_hint"
  >,
) {
  const stmt = db.prepare(`
    UPDATE requirements
    SET verdict = @verdict,
        confidence = @confidence,
        judgment_mode = @judgment_mode,
        why_failed_or_blocked = @why_failed_or_blocked,
        repair_hint = @repair_hint
    WHERE run_id = @runId AND id = @requirementId
  `);
  stmt.run({
    runId,
    requirementId,
    verdict: patch.verdict ?? null,
    confidence: patch.confidence ?? null,
    judgment_mode: patch.judgment_mode ?? null,
    why_failed_or_blocked: patch.why_failed_or_blocked ?? null,
    repair_hint: patch.repair_hint ?? null,
  });
}

export function listRequirements(db: Db, runId: string): RequirementRow[] {
  const stmt = db.prepare(
    `SELECT * FROM requirements WHERE run_id = ? ORDER BY id ASC`,
  );
  return stmt.all(runId) as RequirementRow[];
}
