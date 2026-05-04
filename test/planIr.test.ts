import { describe, expect, it } from "vitest";
import {
  hasUnsafeDomNullDerefInEvaluateScript,
  validatePlan,
} from "../src/planners/planIr.js";
import type { ToolDescriptor } from "../src/planners/planIr.js";

describe("planIr evaluate_script safety", () => {
  it("hasUnsafeDomNullDerefInEvaluateScript flags direct property access", () => {
    expect(
      hasUnsafeDomNullDerefInEvaluateScript(
        "() => document.querySelector('h1').innerText",
      ),
    ).toBe(true);
    expect(
      hasUnsafeDomNullDerefInEvaluateScript(
        "() => document.getElementById('x').textContent",
      ),
    ).toBe(true);
  });

  it("hasUnsafeDomNullDerefInEvaluateScript allows optional chaining", () => {
    expect(
      hasUnsafeDomNullDerefInEvaluateScript(
        "() => document.querySelector('h1')?.innerText ?? ''",
      ),
    ).toBe(false);
  });

  it("validatePlan rejects unsafe evaluate_script", () => {
    const tools: ToolDescriptor[] = [
      {
        name: "evaluate_script",
        inputSchema: {
          type: "object",
          properties: { function: { type: "string" } },
          required: ["function"],
          additionalProperties: false,
        },
      },
    ];
    const res = validatePlan(
      {
        toolCalls: [
          {
            capability: "read_visual",
            tool: "evaluate_script",
            args: {
              function: "() => document.querySelector('.foo').innerText",
            },
          },
        ],
        evidenceBindings: [],
        rubric: [],
        assumptions: [],
      },
      tools,
    );
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.kind === "invalid_args")).toBe(true);
  });
});
