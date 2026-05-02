import { readFileSync } from "node:fs";
import type { FsIntegration } from "../integrations/fs/fsIntegration.js";
import type { HttpIntegration } from "../integrations/http/httpIntegration.js";
import { VerifierError } from "../shared/errors.js";
import type { SpecBundle } from "./bundle.js";

export type ResolvedSpecInputs = {
  combinedMarkdown: string;
  sources: Array<{ kind: string; ref: string; bytes?: number }>;
};

export async function resolveSpecBundle(
  bundle: SpecBundle,
  integrations: { http?: HttpIntegration; fs?: FsIntegration },
): Promise<ResolvedSpecInputs> {
  const parts: string[] = [];
  const sources: ResolvedSpecInputs["sources"] = [];

  for (const item of bundle.inputs) {
    if (item.kind === "markdown") {
      parts.push(item.ref);
      sources.push({
        kind: "markdown",
        ref: "(inline)",
        bytes: item.ref.length,
      });
      continue;
    }

    if (item.kind === "url") {
      if (!integrations.http) {
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          "HTTP integration required to resolve URL spec inputs.",
        );
      }
      const res = await integrations.http.get(item.ref);
      parts.push(`\n\n# Source: ${item.ref}\n\n${res.bodyText}`);
      sources.push({ kind: "url", ref: item.ref, bytes: res.bodyText.length });
      continue;
    }

    if (item.kind === "file") {
      // Prefer fs integration; fall back to direct read for local CLI usage.
      let text: string;
      if (integrations.fs) text = integrations.fs.readText(item.ref);
      else text = readFileSync(item.ref, "utf8");
      parts.push(`\n\n# Source: ${item.ref}\n\n${text}`);
      sources.push({ kind: "file", ref: item.ref, bytes: text.length });
    }
  }

  return { combinedMarkdown: parts.join("\n\n"), sources };
}
