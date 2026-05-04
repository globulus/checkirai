import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArtifactRef } from "../artifacts/types.js";
import type { ToolCallRecord } from "../executors/types.js";
import type { ProbePlan } from "../planners/types.js";
import type { SpecIR } from "../spec/ir.js";
import { judgeDeterministic } from "./judge.js";

function mkToolOutputArtifact(
  root: string,
  id: string,
  body: unknown,
): ArtifactRef {
  const relPath = `tool_output/${id}.json`;
  const abs = join(root, relPath);
  mkdirSync(join(root, "tool_output"), { recursive: true });
  writeFileSync(abs, JSON.stringify(body, null, 2), "utf8");
  return {
    id,
    type: "tool_output",
    path: relPath,
    sha256: "test",
    createdAt: new Date().toISOString(),
  };
}

function mkPlan(reqId: string, probeId: string): ProbePlan {
  return {
    sessions: [
      {
        id: "s1",
        probes: [
          {
            id: probeId,
            requirementId: reqId,
            capabilityNeeds: ["read_ui_structure"],
            sideEffects: "ui_only",
            costHint: 1,
            strategy: "structural_ui",
            steps: [],
          },
        ],
      },
    ],
  };
}

function mkToolCall(
  runId: string,
  probeId: string,
  outputArtifactId: string,
): ToolCallRecord {
  return {
    id: "tc-1",
    runId,
    probeId,
    capability: "read_ui_structure",
    action: "take_snapshot",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ok: true,
    outputArtifactId,
  };
}

describe("judgeDeterministic", () => {
  it("treats text found only in spec-echo regions as missing", () => {
    const root = mkdtempSync(join(tmpdir(), "checkirai-judge-"));
    const runId = "run-1";
    const reqId = "req-1";
    const probeId = "probe-1";

    const art = mkToolOutputArtifact(root, "a1", {
      snapshotText: `Header\nInput Spec IR\nmarkdown spec:\n{ "prompt": "MARKDOWN SPEC: the current time of day" }\nFooter`,
    });

    const spec: SpecIR = {
      run_goal: "t",
      requirements: [
        {
          id: reqId,
          source_text: "Dashboard should show the current time of day",
          type: "structure",
          priority: "must",
          expected_observables: [
            { kind: "text_present", text: "the current time of day" },
          ],
        },
      ],
      acceptance_policy: {
        strictness: "balanced",
        allow_model_assist: true,
        observable_detail: "detailed",
      },
    };

    const out = judgeDeterministic({
      spec,
      plan: mkPlan(reqId, probeId),
      toolCalls: [mkToolCall(runId, probeId, art.id)],
      artifacts: [art],
      artifactRootDir: root,
      selfTestTargetBaseUrl: "http://127.0.0.1:1/",
      targetBaseUrl: "http://127.0.0.1:1/",
    });

    expect(out[0]?.verdict).toBe("fail");
    expect(out[0]?.why_failed_or_blocked ?? "").toContain("Missing text");
  });

  it("passes time_present when a time-like string exists in snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "checkirai-judge-"));
    const runId = "run-2";
    const reqId = "req-1";
    const probeId = "probe-1";

    const art = mkToolOutputArtifact(root, "a1", {
      snapshotText: `uid=1 RootWebArea\n  uid=2 StaticText "It is 5:37 PM right now"\n`,
    });

    const spec: SpecIR = {
      run_goal: "t",
      requirements: [
        {
          id: reqId,
          source_text: "Dashboard should show the current time of day",
          type: "visible_state",
          priority: "must",
          expected_observables: [{ kind: "time_present" }],
        },
      ],
      acceptance_policy: {
        strictness: "balanced",
        allow_model_assist: true,
        observable_detail: "detailed",
      },
    };

    const out = judgeDeterministic({
      spec,
      plan: mkPlan(reqId, probeId),
      toolCalls: [mkToolCall(runId, probeId, art.id)],
      artifacts: [art],
      artifactRootDir: root,
    });

    expect(out[0]?.verdict).toBe("pass");
  });

  it("fails button appearance check when computed styles do not match expected named color", () => {
    const root = mkdtempSync(join(tmpdir(), "checkirai-judge-"));
    const runId = "run-3";
    const reqId = "req-1";
    const probeId = "probe-1";

    const snapshot = mkToolOutputArtifact(root, "snap", {
      snapshotText: `uid=1 RootWebArea\n  uid=2 button "Run"\n`,
    });

    const styles = mkToolOutputArtifact(root, "styles", {
      responseText: `Script ran on page and returned:\n\`\`\`json\n[{"text":"Run","color":"rgb(230, 237, 243)","backgroundColor":"rgb(17, 24, 39)","borderColor":"rgb(51, 65, 85)"}]\n\`\`\``,
    });

    const spec: SpecIR = {
      run_goal: "t",
      requirements: [
        {
          id: reqId,
          source_text: "Buttons should be green",
          type: "appearance",
          priority: "must",
          expected_observables: [
            {
              kind: "element_visible",
              selector: "button",
              metadata: { css: { backgroundColor: "green" } },
            },
          ],
        },
      ],
      acceptance_policy: {
        strictness: "balanced",
        allow_model_assist: true,
        observable_detail: "detailed",
      },
    };

    const plan = mkPlan(reqId, probeId);
    const toolCalls: ToolCallRecord[] = [
      { ...mkToolCall(runId, probeId, snapshot.id), id: "tc-snap" },
      {
        ...mkToolCall(runId, probeId, styles.id),
        id: "tc-style",
        capability: "interact",
        action: "evaluate_script",
      },
    ];

    const out = judgeDeterministic({
      spec,
      plan,
      toolCalls,
      artifacts: [snapshot, styles],
      artifactRootDir: root,
    });

    expect(out[0]?.verdict).toBe("fail");
    expect(out[0]?.why_failed_or_blocked ?? "").toContain(
      "Buttons did not match",
    );
  });
});
