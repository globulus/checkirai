import { randomUUID } from "node:crypto";
import type { RequirementIR } from "../../spec/ir.js";
import type { Probe } from "../types.js";

export function planBasicAppearanceProbe(req: RequirementIR): Probe {
  return {
    id: randomUUID(),
    requirementId: req.id,
    capabilityNeeds: ["read_visual", "read_ui_structure", "interact"],
    sideEffects: "ui_only",
    costHint: 6,
    strategy: "basic_appearance",
    steps: [
      {
        capability: "read_visual",
        action: "take_screenshot",
        args: { label: req.id },
      },
      // Snapshot helps correlate visible text and structure for the judge.
      {
        capability: "read_ui_structure",
        action: "take_snapshot",
        args: {},
      },
      // Structured evidence: computed styles for common UI elements.
      // This makes it possible for an LLM (or future deterministic judge) to verify
      // style expectations like “buttons are green”.
      {
        capability: "interact",
        action: "evaluate_script",
        args: {
          function:
            "() => {\n" +
            "  const buttons = Array.from(document.querySelectorAll('button'));\n" +
            "  return buttons.slice(0, 20).map((b) => {\n" +
            "    const cs = window.getComputedStyle(b);\n" +
            "    return {\n" +
            "      text: (b.textContent || '').trim().slice(0, 80),\n" +
            "      color: cs.color,\n" +
            "      backgroundColor: cs.backgroundColor,\n" +
            "      borderColor: cs.borderColor,\n" +
            "    };\n" +
            "  });\n" +
            "}",
        },
      },
    ],
  };
}
