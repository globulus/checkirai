PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  target_base_url TEXT NOT NULL,
  policy_name TEXT,
  llm_provider TEXT,
  llm_model TEXT,
  status TEXT,
  confidence REAL,
  summary_md_path TEXT,
  report_json_path TEXT,
  parent_run_id TEXT,
  restart_from_phase TEXT
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_text TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  verdict TEXT,
  confidence REAL,
  judgment_mode TEXT,
  why_failed_or_blocked TEXT,
  repair_hint TEXT,
  PRIMARY KEY (run_id, id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS probes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  strategy TEXT,
  side_effects TEXT,
  cost_hint INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, requirement_id) REFERENCES requirements(run_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  probe_id TEXT,
  capability TEXT NOT NULL,
  action TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ok INTEGER NOT NULL,
  error_code TEXT,
  error_message TEXT,
  output_artifact_id TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (probe_id) REFERENCES probes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requirement_artifacts (
  run_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY (run_id, requirement_id, artifact_id),
  FOREIGN KEY (run_id, requirement_id) REFERENCES requirements(run_id, id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

