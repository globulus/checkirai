import type { Db } from "../db.js";

export type ProbeRow = {
  id: string;
  run_id: string;
  requirement_id: string;
  strategy?: string | null;
  side_effects?: string | null;
  cost_hint?: number | null;
};

export function insertProbes(db: Db, rows: ProbeRow[]) {
  const stmt = db.prepare(`
    INSERT INTO probes (id, run_id, requirement_id, strategy, side_effects, cost_hint)
    VALUES (@id, @run_id, @requirement_id, @strategy, @side_effects, @cost_hint)
  `);
  const tx = db.transaction((rs: ProbeRow[]) => {
    for (const r of rs)
      stmt.run({
        ...r,
        strategy: r.strategy ?? null,
        side_effects: r.side_effects ?? null,
        cost_hint: r.cost_hint ?? null,
      });
  });
  tx(rows);
}

export function listProbes(db: Db, runId: string): ProbeRow[] {
  const stmt = db.prepare(
    `SELECT * FROM probes WHERE run_id = ? ORDER BY cost_hint ASC, id ASC`,
  );
  return stmt.all(runId) as ProbeRow[];
}
