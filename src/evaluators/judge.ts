import type { ArtifactRef } from "../artifacts/types.js";
import type { RequirementResult } from "../core/result.js";
import type { ToolCallRecord } from "../executors/types.js";
import type { ProbePlan } from "../planners/types.js";
import type { SpecIR } from "../spec/ir.js";
import { getExpectedObservables } from "../spec/observables.js";
import { readArtifactJson } from "./artifactReader.js";

export type JudgeInput = {
  spec: SpecIR;
  plan: ProbePlan;
  toolCalls: ToolCallRecord[];
  artifacts: ArtifactRef[];
  artifactRootDir: string;
};

function indexOfAny(haystackLower: string, needles: string[]): number {
  for (const n of needles) {
    const i = haystackLower.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

function isLikelySpecEcho(snapshotText: string, expectedText: string): boolean {
  const snap = snapshotText.toLowerCase();
  const exp = expectedText.toLowerCase();
  const expIdx = snap.indexOf(exp);
  if (expIdx < 0) return false;

  // The dashboard UI includes large echoed blocks of "Input Spec IR" and the spec normalization
  // prompt ("MARKDOWN SPEC: ..."). Text appearing *only* in those regions should not count as
  // evidence that the underlying page implements the behavior.
  const specMarkers = [
    "input spec ir",
    "markdown spec:",
    "\"prompt\":",
    "convert the markdown spec below into json",
  ];
  const markerIdx = indexOfAny(snap, specMarkers);
  return markerIdx >= 0 && expIdx > markerIdx;
}

function parseJsonFromCodeFence(s: string): unknown | undefined {
  const m = s.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!m?.[1]) return;
  try {
    return JSON.parse(m[1]);
  } catch {
    return;
  }
}

type ButtonStyleSample = {
  text?: string;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
};

function cssNamedColorToRgbLower(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  // Minimal mapping for our normalizer’s color vocabulary.
  if (n === "green") return "rgb(0, 128, 0)";
  if (n === "red") return "rgb(255, 0, 0)";
  if (n === "blue") return "rgb(0, 0, 255)";
  if (n === "black") return "rgb(0, 0, 0)";
  if (n === "white") return "rgb(255, 255, 255)";
  if (n === "yellow") return "rgb(255, 255, 0)";
  if (n === "orange") return "rgb(255, 165, 0)";
  if (n === "purple") return "rgb(128, 0, 128)";
  return;
}

function extractButtonStyleEvidence(
  toolOutputArtifacts: ArtifactRef[],
  artifactRootDir: string,
): ButtonStyleSample[] | undefined {
  // We intentionally look for an evaluate_script tool output that contains a JSON code fence
  // with computed styles (see basicAppearance probe strategy).
  for (const a of toolOutputArtifacts.slice().reverse()) {
    try {
      const obj = readArtifactJson<unknown>(artifactRootDir, a);
      const rt = (obj as { responseText?: unknown } | null)?.responseText;
      if (typeof rt !== "string") continue;
      const parsed = parseJsonFromCodeFence(rt);
      if (!Array.isArray(parsed)) continue;
      // Best-effort validation: ensure at least one entry looks like our samples.
      if (
        parsed.some(
          (x) =>
            x &&
            typeof x === "object" &&
            ("backgroundColor" in (x as Record<string, unknown>) ||
              "color" in (x as Record<string, unknown>)),
        )
      ) {
        return parsed as ButtonStyleSample[];
      }
    } catch {
      // ignore
    }
  }
  return;
}

function checkTimePresent(snapshotText: string): boolean {
  // Matches common UI time formats: "5:37 PM", "17:37", "5:37pm", etc.
  // We prefer real times over the literal phrase "current time of day".
  const withoutSpecEcho = snapshotText;
  const timeRe = /\b([01]?\d|2[0-3]):[0-5]\d(\s?(am|pm))?\b/i;
  return timeRe.test(withoutSpecEcho);
}

/**
 * MVP deterministic judging:
 * - If any tool call for a requirement's probe failed => `blocked`.
 * - If we have at least one a11y snapshot artifact, we can deterministically check:
 *   - text_present: substring match
 *   - role_present: substring match (best-effort; depends on snapshot format)
 *   - url_matches: currently not enforced (needs dedicated URL read)
 * - If all expectations are satisfied => `pass`
 * - If any expectation contradicts evidence => `fail`
 * - Otherwise => `inconclusive`
 */
export function judgeDeterministic(input: JudgeInput): RequirementResult[] {
  const toolCallsByProbe = new Map<string, ToolCallRecord[]>();
  for (const tc of input.toolCalls) {
    const pid = tc.probeId ?? "unknown";
    const arr = toolCallsByProbe.get(pid) ?? [];
    arr.push(tc);
    toolCallsByProbe.set(pid, arr);
  }

  const probeByRequirement = new Map<string, string[]>();
  for (const s of input.plan.sessions) {
    for (const p of s.probes) {
      const arr = probeByRequirement.get(p.requirementId) ?? [];
      arr.push(p.id);
      probeByRequirement.set(p.requirementId, arr);
    }
  }

  const artifactsById = new Map(input.artifacts.map((a) => [a.id, a] as const));

  return input.spec.requirements.map((r) => {
    const probeIds = probeByRequirement.get(r.id) ?? [];
    const calls = probeIds.flatMap((pid) => toolCallsByProbe.get(pid) ?? []);
    const anyFailed = calls.some((c) => !c.ok);
    if (anyFailed) {
      return {
        requirement_id: r.id,
        verdict: "blocked",
        confidence: 0,
        judgment_mode: "deterministic",
        evidence_refs: [],
        expected: {
          source_text: r.source_text,
          expected_observables: r.expected_observables,
        },
        why_failed_or_blocked:
          calls.find((c) => !c.ok)?.errorMessage ?? "Probe failed.",
      };
    }

    // Pull snapshot text from the most recent tool_output JSON artifact that includes snapshotText (best-effort).
    // We rely on tool_output artifacts being written by the executor and read them from disk.
    const snapshotNeedle = "snapshotText";
    const toolOutputArtifacts = calls
      .map((c) => c.outputArtifactId)
      .filter(Boolean)
      .map((id) => artifactsById.get(id as string))
      .filter(Boolean) as ArtifactRef[];

    let snapshotText: string | undefined;
    for (const a of toolOutputArtifacts.reverse()) {
      try {
        const obj = readArtifactJson<unknown>(input.artifactRootDir, a);
        const st = (obj as { snapshotText?: unknown } | null)?.snapshotText;
        if (typeof st === "string" && st.includes(snapshotNeedle)) {
          snapshotText = st;
          break;
        }
        if (typeof st === "string") {
          snapshotText = st;
          break;
        }
      } catch {
        // ignore and continue
      }
    }

    const exps = getExpectedObservables(input.spec, r);
    if (exps.length === 0) {
      return {
        requirement_id: r.id,
        verdict: "inconclusive",
        confidence: 0.3,
        judgment_mode: "deterministic",
        evidence_refs: [],
        expected: {
          source_text: r.source_text,
          expected_observables: exps,
        },
        why_failed_or_blocked: "No explicit expected_observables provided.",
      };
    }

    if (!snapshotText) {
      return {
        requirement_id: r.id,
        verdict: "inconclusive",
        confidence: 0.2,
        judgment_mode: "deterministic",
        evidence_refs: [],
        expected: {
          source_text: r.source_text,
          expected_observables: r.expected_observables,
        },
        why_failed_or_blocked:
          "No snapshot evidence available for expectation matching.",
      };
    }

    const failures: string[] = [];
    const unchecked: string[] = [];

    const buttonStyleEvidence = extractButtonStyleEvidence(
      toolOutputArtifacts,
      input.artifactRootDir,
    );

    for (const e of exps) {
      if (e.kind === "text_present" && e.text) {
        if (
          !snapshotText.toLowerCase().includes(e.text.toLowerCase()) ||
          isLikelySpecEcho(snapshotText, e.text)
        )
          failures.push(`Missing text: "${e.text}"`);
      } else if (e.kind === "role_present" && e.role) {
        if (!snapshotText.toLowerCase().includes(e.role.toLowerCase()))
          failures.push(`Missing role: "${e.role}"`);
      } else if (e.kind === "time_present") {
        if (!checkTimePresent(snapshotText)) failures.push("No time-like string found in visible UI.");
      } else if (
        e.kind === "element_visible" &&
        e.selector &&
        e.selector.toLowerCase() === "button" &&
        e.metadata &&
        typeof e.metadata === "object" &&
        "css" in e.metadata
      ) {
        // Minimal deterministic appearance check for button colors, based on the basicAppearance probe’s
        // computed style evidence (evaluate_script output).
        const css = (e.metadata as { css?: unknown }).css;
        const cssObj =
          css && typeof css === "object" ? (css as Record<string, unknown>) : undefined;
        const expectedBgRaw =
          typeof cssObj?.backgroundColor === "string"
            ? (cssObj.backgroundColor as string)
            : undefined;
        const expectedFgRaw =
          typeof cssObj?.color === "string" ? (cssObj.color as string) : undefined;
        const expectedColorRaw = expectedBgRaw ?? expectedFgRaw;
        if (!expectedColorRaw) {
          unchecked.push("element_visible(css)");
          continue;
        }
        const expectedRgb = cssNamedColorToRgbLower(expectedColorRaw);
        if (!expectedRgb) {
          unchecked.push("element_visible(css)");
          continue;
        }
        if (!buttonStyleEvidence?.length) {
          unchecked.push("element_visible(css)");
          continue;
        }
        const anyMatches = buttonStyleEvidence.some((b) => {
          const bg = (b.backgroundColor ?? "").toLowerCase();
          const fg = (b.color ?? "").toLowerCase();
          if (expectedBgRaw) return bg === expectedRgb;
          return fg === expectedRgb;
        });
        if (!anyMatches) {
          failures.push(
            `Buttons did not match expected css color "${expectedColorRaw}" (expected ${expectedRgb}).`,
          );
        }
      } else {
        unchecked.push(e.kind);
      }
    }

    const verdict = failures.length
      ? "fail"
      : unchecked.length
        ? "inconclusive"
        : "pass";
    return {
      requirement_id: r.id,
      verdict,
      confidence: verdict === "pass" ? 0.8 : verdict === "fail" ? 0.6 : 0.3,
      judgment_mode: "deterministic",
      evidence_refs: [],
      expected: {
        source_text: r.source_text,
        expected_observables: exps,
      },
      observed: { snapshotEvidence: "a11y_snapshot_text" },
      diff:
        failures.length || unchecked.length
          ? {
              ...(failures.length ? { failures } : {}),
              ...(unchecked.length ? { unchecked } : {}),
            }
          : undefined,
      why_failed_or_blocked: failures.length
        ? failures.join("; ")
        : unchecked.length
          ? `Deterministic judge does not implement: ${unchecked.join(", ")}`
          : undefined,
    };
  });
}
