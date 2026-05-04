import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve `package.json` version by walking up from this module (works for src/ and dist/). */
export function readCliPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const p = join(dir, "package.json");
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (raw.name === "checkirai" && typeof raw.version === "string")
        return raw.version;
    } catch {
      // ignore
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
