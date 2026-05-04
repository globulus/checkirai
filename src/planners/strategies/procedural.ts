import { randomUUID } from "node:crypto";
import { Capability } from "../../capabilities/types.js";
import type { RequirementIR, StepIR } from "../../spec/ir.js";
import type { CapabilityName, Probe, ProbeStep } from "../types.js";

function stepsToProbeSteps(steps: StepIR[]): ProbeStep[] {
  const out: ProbeStep[] = [];
  for (const s of steps) {
    if (s.kind === "navigate") {
      out.push({
        capability: Capability.navigate,
        action: "navigate_page",
        args: { url: s.text ?? "" },
      });
      continue;
    }
    if (s.kind === "wait") {
      // Map to the chrome-devtools-mcp `wait_for` tool via direct tool call.
      // We keep args minimal; tool schema is provided by the MCP server.
      out.push({
        capability: Capability.interact,
        action: "wait_for",
        args: s.text
          ? {
              // MCP expects an array of strings.
              text: [s.text],
              // Default to 5s unless the spec explicitly provided a wait duration.
              timeout: typeof s.ms === "number" ? s.ms : 5000,
            }
          : {},
      });
      continue;
    }
    if (s.kind === "press") {
      out.push({
        capability: Capability.interact,
        action: "press_key",
        args: s.key ? { key: s.key } : {},
      });
      continue;
    }
    if (s.kind === "type") {
      out.push({
        capability: Capability.interact,
        // Use our higher-level adapter for typing.
        action: "run_steps",
        args: { kind: "type", text: s.text ?? "" },
      });
      continue;
    }
    if (s.kind === "click") {
      // MVP: click by visible text (uses a snapshot->uid lookup).
      out.push({
        capability: Capability.interact,
        action: "run_steps",
        args: { kind: "click_text", text: s.text ?? "" },
      });
      continue;
    }
    if (s.kind === "fill") {
      out.push({
        capability: Capability.interact,
        action: "run_steps",
        args: {
          kind: "fill_text",
          needle: s.selector ?? s.text ?? "",
          value: s.text ?? "",
        },
      });
      continue;
    }
    if (s.kind === "tool_call") {
      // Generic passthrough to chrome-devtools-mcp tool surface.
      // This is the core “evidence collection” mechanism for the LLM planner.
      out.push({
        capability: Capability.interact,
        action: String(s.tool ?? ""),
        args: (s.toolArgs ?? {}) as Record<string, unknown>,
      });
    }
    // assert is handled by the judge; we still want evidence.
  }
  return out;
}

export function planProceduralProbe(req: RequirementIR): Probe {
  const steps: StepIR[] = [
    ...(req.preconditions ?? []),
    ...(req.actions ?? []),
  ];

  const probeSteps: ProbeStep[] = [
    ...stepsToProbeSteps(steps),
    // Evidence capture: take a snapshot at the end of the procedure.
    {
      capability: Capability.read_ui_structure,
      action: "take_snapshot",
      args: {},
    },
    // Also grab a screenshot to support appearance/visual judgments.
    {
      capability: Capability.read_visual,
      action: "take_screenshot",
      args: {},
    },
    // Capture console + network for debugging/integration expectations.
    {
      capability: Capability.read_console,
      action: "list_console_messages",
      args: {},
    },
    {
      capability: Capability.read_network,
      action: "list_network_requests",
      args: {},
    },
  ];

  const capabilityNeeds = Array.from(
    new Set(probeSteps.map((s) => s.capability)),
  ) as CapabilityName[];

  return {
    id: randomUUID(),
    requirementId: req.id,
    capabilityNeeds,
    sideEffects: "ui_only",
    costHint: 3,
    strategy: "procedural",
    steps: probeSteps,
  };
}
