import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef } from "../artifacts/types.js";
import { VerifierError } from "../shared/errors.js";

export function readArtifactText(rootDir: string, ref: ArtifactRef): string {
  try {
    return readFileSync(join(rootDir, ref.path), "utf8");
  } catch (cause) {
    throw new VerifierError(
      "TOOL_UNAVAILABLE",
      `Failed to read artifact: ${ref.path}`,
      { cause },
    );
  }
}

export function readArtifactJson<T = unknown>(
  rootDir: string,
  ref: ArtifactRef,
): T {
  const text = readArtifactText(rootDir, ref);
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new VerifierError(
      "TOOL_UNAVAILABLE",
      `Invalid JSON artifact: ${ref.path}`,
      { cause },
    );
  }
}
