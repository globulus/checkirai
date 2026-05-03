import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Keep only the `maxRuns` most recently modified run directories under `artifactsRoot`.
 * Each run stores artifacts in `artifactsRoot/<runId>/...`.
 */
export function pruneArtifactRuns(
  artifactsRoot: string,
  maxRuns: number,
): void {
  if (maxRuns <= 0) return;
  let names: string[];
  try {
    names = readdirSync(artifactsRoot);
  } catch {
    return;
  }
  const withMtime = names
    .map((name) => {
      const abs = join(artifactsRoot, name);
      try {
        const st = statSync(abs);
        if (!st.isDirectory()) return null;
        return { name, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ name: string; mtime: number }>;

  if (withMtime.length <= maxRuns) return;
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const victims = withMtime.slice(maxRuns);
  for (const v of victims) {
    try {
      rmSync(join(artifactsRoot, v.name), { recursive: true, force: true });
    } catch {
      // ignore per-directory failures
    }
  }
}
