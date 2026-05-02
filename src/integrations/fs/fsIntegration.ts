import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VerifierError } from "../../shared/errors.js";

export type FsIntegration = {
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
};

export function createFsIntegration(opts?: {
  rootDir?: string;
}): FsIntegration {
  const rootDir = opts?.rootDir;

  const resolvePath = (p: string) => (rootDir ? resolve(rootDir, p) : p);

  return {
    readText(path: string) {
      try {
        return readFileSync(resolvePath(path), "utf8");
      } catch (cause) {
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Failed to read file: ${path}`,
          { cause },
        );
      }
    },
    readBytes(path: string) {
      try {
        return readFileSync(resolvePath(path));
      } catch (cause) {
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Failed to read file: ${path}`,
          { cause },
        );
      }
    },
  };
}
