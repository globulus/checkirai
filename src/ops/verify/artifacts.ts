import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "../../artifacts/store.js";
import { insertArtifact } from "../../persistence/repo/artifactRepo.js";
import type { OpsContext } from "../context.js";

export function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function persistLlmOutputJsonArtifact(opts: {
  db: OpsContext["db"];
  artifactsDir: string;
  runId: string;
  value: unknown;
  metadata: Record<string, unknown>;
}) {
  const store = new ArtifactStore({
    rootDir: opts.artifactsDir,
    runId: opts.runId,
  });
  const ref = store.writeJson("llm_output", opts.value, {
    metadata: opts.metadata,
  });
  insertArtifact(opts.db, {
    id: ref.id,
    run_id: opts.runId,
    type: ref.type,
    path: join(opts.artifactsDir, ref.path),
    sha256: ref.sha256,
    created_at: ref.createdAt,
    metadata_json: ref.metadata ? JSON.stringify(ref.metadata) : null,
  });
}
