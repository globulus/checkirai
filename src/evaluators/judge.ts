import type { ArtifactRef } from "../artifacts/types.js";
import type { RequirementResult } from "../core/result.js";
import type { ToolCallRecord } from "../executors/types.js";
import type { ProbePlan } from "../planners/types.js";
import type {
  ObservableExpectationIR,
  RequirementIR,
  SpecIR,
} from "../spec/ir.js";
import { SPEC_ECHO_MARKERS } from "../spec/llmPromptConstants.js";
import { getExpectedObservables } from "../spec/observables.js";
import { readArtifactJson, readArtifactText } from "./artifactReader.js";

export type JudgeInput = {
  spec: SpecIR;
  plan: ProbePlan;
  toolCalls: ToolCallRecord[];
  artifacts: ArtifactRef[];
  artifactRootDir: string;
  /**
   * When set, `isLikelySpecEcho` is enabled only if the target base URL matches
   * (verifier dashboard self-test).
   */
  selfTestTargetBaseUrl?: string;
  /** Current run target; compared to `selfTestTargetBaseUrl` to gate spec-echo heuristics. */
  targetBaseUrl?: string;
};

function indexOfAny(haystackLower: string, needles: string[]): number {
  for (const n of needles) {
    const i = haystackLower.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

function isLikelySpecEcho(
  snapshotText: string,
  expectedText: string,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  const snap = snapshotText.toLowerCase();
  const exp = expectedText.toLowerCase();
  const expIdx = snap.indexOf(exp);
  if (expIdx < 0) return false;

  const specMarkers = [...SPEC_ECHO_MARKERS];
  const hits = specMarkers.filter((m) => snap.includes(m));
  if (hits.length < 2) return false;
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

/** Normalize hex / rgb() / rgba() / named colors to lower-case `rgb(r, g, b)` when parseable. */
function cssColorToRgbNormalized(raw: string): string | undefined {
  const s = raw.trim().toLowerCase();
  const named = cssNamedColorToRgbLower(s);
  if (named) return named;

  const hexM = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hexM?.[1]) {
    let h = hexM[1];
    if (h.length === 3) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const r = Number.parseInt(h.slice(0, 2), 16);
    const g = Number.parseInt(h.slice(2, 4), 16);
    const b = Number.parseInt(h.slice(4, 6), 16);
    if ([r, g, b].every((x) => Number.isFinite(x)))
      return `rgb(${r}, ${g}, ${b})`;
  }

  const rgbM = s.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/,
  );
  if (rgbM) {
    return `rgb(${rgbM[1]}, ${rgbM[2]}, ${rgbM[3]})`;
  }
  return;
}

function styleColorMatches(expectedRaw: string, actualRaw: string): boolean {
  const exp = cssColorToRgbNormalized(expectedRaw);
  const act = cssColorToRgbNormalized(actualRaw);
  if (exp && act) return exp === act;
  return actualRaw.toLowerCase().includes(expectedRaw.trim().toLowerCase());
}

function extractButtonStyleEvidence(
  toolOutputArtifacts: ArtifactRef[],
  artifactRootDir: string,
): ButtonStyleSample[] | undefined {
  for (const a of [...toolOutputArtifacts].reverse()) {
    try {
      const obj = readArtifactJson<unknown>(artifactRootDir, a);
      const rt = (obj as { responseText?: unknown } | null)?.responseText;
      if (typeof rt !== "string") continue;
      const parsed = parseJsonFromCodeFence(rt);
      if (!Array.isArray(parsed)) continue;
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

function collectToolOutputBodies(
  toolOutputArtifacts: ArtifactRef[],
  artifactRootDir: string,
): unknown[] {
  const out: unknown[] = [];
  for (const a of toolOutputArtifacts) {
    try {
      out.push(readArtifactJson<unknown>(artifactRootDir, a));
    } catch {
      // ignore
    }
  }
  return out;
}

function stringifyEvidence(v: unknown): string {
  try {
    return JSON.stringify(v).toLowerCase();
  } catch {
    return String(v).toLowerCase();
  }
}

function latestPageUrlFromCalls(
  calls: ToolCallRecord[],
  artifactsById: Map<string, ArtifactRef>,
  root: string,
): string | undefined {
  const arts = calls
    .map((c) => c.outputArtifactId)
    .filter(Boolean)
    .map((id) => artifactsById.get(id as string))
    .filter(Boolean) as ArtifactRef[];
  for (const a of [...arts].reverse()) {
    try {
      const obj = readArtifactJson<unknown>(root, a);
      const u = (obj as { pageUrl?: unknown } | null)?.pageUrl;
      if (typeof u === "string" && u.trim()) return u.trim();
    } catch {
      // ignore
    }
  }
  return;
}

function normalizeUrlForCompare(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    let p = x.pathname.replace(/\/+$/, "");
    if (p === "") p = "/";
    x.pathname = p;
    return x.toString();
  } catch {
    return u.trim();
  }
}

function urlMatchesEvidence(expectedUrl: string, actual?: string): boolean {
  if (!actual?.trim()) return false;
  return normalizeUrlForCompare(expectedUrl) === normalizeUrlForCompare(actual);
}

function checkTimePresent(snapshotText: string): boolean {
  const timeRe = /\b([01]?\d|2[0-3]):[0-5]\d(\s?(am|pm))?\b/i;
  return timeRe.test(snapshotText);
}

function observableNeedsSnapshot(e: ObservableExpectationIR): boolean {
  return !(
    e.kind === "url_matches" ||
    e.kind === "http_response" ||
    e.kind === "network_request" ||
    e.kind === "file_contains"
  );
}

function judgeRequirement(
  input: JudgeInput,
  r: RequirementIR,
  toolCallsByProbe: Map<string, ToolCallRecord[]>,
  probeByRequirement: Map<string, string[]>,
  artifactsById: Map<string, ArtifactRef>,
): RequirementResult {
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

  const toolOutputArtifacts = calls
    .map((c) => c.outputArtifactId)
    .filter(Boolean)
    .map((id) => artifactsById.get(id as string))
    .filter(Boolean) as ArtifactRef[];

  const specEchoEnabled = Boolean(
    input.selfTestTargetBaseUrl?.trim() &&
      input.targetBaseUrl?.trim() &&
      input.selfTestTargetBaseUrl.trim() === input.targetBaseUrl.trim(),
  );

  let snapshotText: string | undefined;
  const a11yOrdered = input.artifacts
    .filter((a) => a.type === "a11y_snapshot")
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const a of a11yOrdered) {
    try {
      const txt = readArtifactText(input.artifactRootDir, a).trim();
      if (txt) {
        snapshotText = txt;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (!snapshotText) {
    for (const a of [...toolOutputArtifacts].reverse()) {
      try {
        const obj = readArtifactJson<unknown>(input.artifactRootDir, a);
        const st = (obj as { snapshotText?: unknown } | null)?.snapshotText;
        if (typeof st === "string" && st.length > 0) {
          snapshotText = st;
          break;
        }
      } catch {
        // ignore
      }
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

  const bodies = collectToolOutputBodies(
    toolOutputArtifacts,
    input.artifactRootDir,
  );
  const evidenceBlob = stringifyEvidence(bodies);
  const pageUrl = latestPageUrlFromCalls(
    calls,
    artifactsById,
    input.artifactRootDir,
  );

  const needsSnap = exps.some(observableNeedsSnapshot);
  if (needsSnap && !snapshotText) {
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
  const snap = snapshotText ?? "";

  for (const e of exps) {
    if (e.kind === "text_present" && e.text) {
      if (
        !snap.toLowerCase().includes(e.text.toLowerCase()) ||
        isLikelySpecEcho(snap, e.text, specEchoEnabled)
      )
        failures.push(`Missing text: "${e.text}"`);
    } else if (e.kind === "role_present" && e.role) {
      if (!snap.toLowerCase().includes(e.role.toLowerCase()))
        failures.push(`Missing role: "${e.role}"`);
    } else if (e.kind === "time_present") {
      if (!checkTimePresent(snap))
        failures.push("No time-like string found in visible UI.");
    } else if (e.kind === "url_matches" && e.url) {
      if (!urlMatchesEvidence(e.url, pageUrl))
        failures.push(
          `URL did not match expected "${e.url}" (got ${pageUrl ?? "none"}).`,
        );
    } else if (e.kind === "element_visible" && e.selector) {
      const sel = e.selector.toLowerCase();
      if (
        e.selector.toLowerCase() === "button" &&
        e.metadata &&
        typeof e.metadata === "object" &&
        "css" in e.metadata
      ) {
        const css = (e.metadata as { css?: unknown }).css;
        const cssObj =
          css && typeof css === "object"
            ? (css as Record<string, unknown>)
            : undefined;
        const expectedBgRaw =
          typeof cssObj?.backgroundColor === "string"
            ? (cssObj.backgroundColor as string)
            : undefined;
        const expectedFgRaw =
          typeof cssObj?.color === "string"
            ? (cssObj.color as string)
            : undefined;
        const expectedColorRaw = expectedBgRaw ?? expectedFgRaw;
        if (!expectedColorRaw) {
          unchecked.push("element_visible(css)");
          continue;
        }
        if (expectedColorRaw.includes("var(")) {
          unchecked.push("element_visible(css:var)");
          continue;
        }
        if (!buttonStyleEvidence?.length) {
          unchecked.push("element_visible(css)");
          continue;
        }
        const anyMatches = buttonStyleEvidence.some((b) => {
          const bg = b.backgroundColor ?? "";
          const fg = b.color ?? "";
          if (expectedBgRaw) return styleColorMatches(expectedColorRaw, bg);
          return styleColorMatches(expectedColorRaw, fg);
        });
        if (!anyMatches) {
          failures.push(
            `Buttons did not match expected css color "${expectedColorRaw}".`,
          );
        }
      } else {
        if (!snap.toLowerCase().includes(sel))
          failures.push(
            `Selector/role hint "${e.selector}" not found in snapshot.`,
          );
      }
    } else if (e.kind === "element_enabled" && e.selector) {
      const needle = e.selector.toLowerCase();
      if (!snap.toLowerCase().includes(needle)) {
        failures.push(`Element "${e.selector}" not found for enabled check.`);
      } else {
        const lower = snap.toLowerCase();
        const idx = lower.indexOf(needle);
        const window = snap.slice(
          Math.max(0, idx - 120),
          idx + needle.length + 120,
        );
        if (/\bdisabled\b/i.test(window))
          failures.push(`Element "${e.selector}" appears disabled.`);
      }
    } else if (e.kind === "toast_present") {
      const t = snap.toLowerCase();
      if (
        !t.includes("toast") &&
        !t.includes("snackbar") &&
        !t.includes("alert") &&
        !t.includes("notification")
      ) {
        failures.push("No toast/snackbar/alert-like region found in snapshot.");
      }
    } else if (e.kind === "network_request" && e.pattern) {
      if (!evidenceBlob.includes(e.pattern.toLowerCase()))
        failures.push(
          `Network evidence did not include pattern "${e.pattern}".`,
        );
    } else if (e.kind === "http_response" && e.url) {
      const hit = bodies.find(
        (b) =>
          b &&
          typeof b === "object" &&
          String((b as Record<string, unknown>).url ?? "") === e.url,
      );
      const status = hit
        ? Number((hit as Record<string, unknown>).status)
        : undefined;
      if (!hit || !Number.isFinite(status)) {
        failures.push(`No HTTP response evidence for URL "${e.url}".`);
      } else if (typeof status === "number" && status >= 400) {
        failures.push(`HTTP ${status} for "${e.url}".`);
      }
    } else if (e.kind === "file_contains") {
      const needle = e.pattern ?? e.text;
      if (!needle) {
        unchecked.push("file_contains");
        continue;
      }
      const fileHit = bodies.find(
        (b) =>
          b &&
          typeof b === "object" &&
          typeof (b as Record<string, unknown>).text === "string",
      ) as { text?: string } | undefined;
      const text = fileHit?.text ?? "";
      if (!text.toLowerCase().includes(needle.toLowerCase())) {
        failures.push(`File contents did not include "${needle}".`);
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
}

/**
 * Deterministic judging: tool failures => blocked; snapshot + tool outputs => expectation checks.
 */
export function judgeDeterministic(input: JudgeInput): RequirementResult[] {
  const toolCallsByProbe = new Map<string, ToolCallRecord[]>();
  for (const tc of input.toolCalls) {
    const pid = tc.probeId ?? `__call:${tc.id}`;
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

  const raw = input.spec.requirements.map((r) =>
    judgeRequirement(
      input,
      r,
      toolCallsByProbe,
      probeByRequirement,
      artifactsById,
    ),
  );
  const byId = new Map(raw.map((x) => [x.requirement_id, x] as const));

  return raw.map((rr) => {
    const req = input.spec.requirements.find((x) => x.id === rr.requirement_id);
    for (const d of req?.depends_on ?? []) {
      const dep = byId.get(d);
      if (dep && (dep.verdict === "fail" || dep.verdict === "blocked")) {
        return {
          ...rr,
          verdict: "blocked" as const,
          confidence: 0,
          judgment_mode: "deterministic" as const,
          why_failed_or_blocked: `Blocked because prerequisite "${d}" is ${dep.verdict}: ${dep.why_failed_or_blocked ?? ""}`,
        };
      }
    }
    return rr;
  });
}
