import type { Db } from "../db.js";

export type ArtifactRow = {
  id: string;
  run_id: string;
  type: string;
  path: string;
  sha256: string;
  created_at: string;
  metadata_json?: string | null;
};

export function insertArtifact(db: Db, row: ArtifactRow) {
  const stmt = db.prepare(`
    INSERT INTO artifacts (id, run_id, type, path, sha256, created_at, metadata_json)
    VALUES (@id, @run_id, @type, @path, @sha256, @created_at, @metadata_json)
  `);
  stmt.run(row);
}

export function linkRequirementArtifact(
  db: Db,
  runId: string,
  requirementId: string,
  artifactId: string,
) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO requirement_artifacts (run_id, requirement_id, artifact_id)
    VALUES (@runId, @requirementId, @artifactId)
  `);
  stmt.run({ runId, requirementId, artifactId });
}

export function listArtifacts(db: Db, runId: string): ArtifactRow[] {
  const stmt = db.prepare(
    `SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC`,
  );
  return stmt.all(runId) as ArtifactRow[];
}

/** Latest `llm_output` whose JSON metadata includes `kind` (e.g. spec_ir, test_plan_ir). */
export function findLatestLlmOutputByKind(
  db: Db,
  runId: string,
  kind: string,
): ArtifactRow | undefined {
  const rows = listArtifacts(db, runId).filter((r) => r.type === "llm_output");
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r?.metadata_json) continue;
    try {
      const meta = JSON.parse(r.metadata_json) as { kind?: unknown };
      if (meta.kind === kind) return r;
    } catch {
      // skip invalid metadata
    }
  }
  return undefined;
}
