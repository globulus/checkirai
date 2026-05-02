import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactRef, ArtifactType } from "./types.js";

export type ArtifactStoreConfig = {
  rootDir: string;
  runId: string;
};

export class ArtifactStore {
  readonly rootDir: string;
  readonly runId: string;

  constructor(cfg: ArtifactStoreConfig) {
    this.rootDir = cfg.rootDir;
    this.runId = cfg.runId;
  }

  private ensureDir(path: string) {
    mkdirSync(path, { recursive: true });
  }

  private sha256(data: Uint8Array | string): string {
    const h = createHash("sha256");
    h.update(data);
    return h.digest("hex");
  }

  private artifactPath(type: ArtifactType, ext: string) {
    const id = randomUUID();
    const rel = join(this.runId, type, `${id}.${ext}`);
    const abs = join(this.rootDir, rel);
    return { id, rel, abs };
  }

  writeText(
    type: ArtifactType,
    text: string,
    opts?: { ext?: string; metadata?: Record<string, unknown> },
  ): ArtifactRef {
    const ext = opts?.ext ?? "txt";
    const { id, rel, abs } = this.artifactPath(type, ext);
    this.ensureDir(dirname(abs));
    writeFileSync(abs, text, "utf8");
    return {
      id,
      type,
      path: rel,
      sha256: this.sha256(text),
      createdAt: new Date().toISOString(),
      metadata: opts?.metadata,
    };
  }

  writeJson(
    type: ArtifactType,
    value: unknown,
    opts?: { ext?: string; metadata?: Record<string, unknown> },
  ): ArtifactRef {
    const ext = opts?.ext ?? "json";
    const text = JSON.stringify(value, null, 2);
    const arg: { ext?: string; metadata?: Record<string, unknown> } = { ext };
    if (opts?.metadata) arg.metadata = opts.metadata;
    return this.writeText(type, text, arg);
  }

  writeBytes(
    type: ArtifactType,
    bytes: Uint8Array,
    opts?: { ext?: string; metadata?: Record<string, unknown> },
  ): ArtifactRef {
    const ext = opts?.ext ?? "bin";
    const { id, rel, abs } = this.artifactPath(type, ext);
    this.ensureDir(dirname(abs));
    writeFileSync(abs, bytes);
    return {
      id,
      type,
      path: rel,
      sha256: this.sha256(bytes),
      createdAt: new Date().toISOString(),
      metadata: opts?.metadata,
    };
  }
}
