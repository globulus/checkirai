import { describe, expect, it } from "vitest";
import {
  effectiveOllamaJsonFormatForJudge,
  isLikelyThinkingOllamaModel,
} from "../src/llm/ollamaJudgeJsonFormat.js";

describe("isLikelyThinkingOllamaModel", () => {
  it("detects DeepSeek R1 and QwQ", () => {
    expect(isLikelyThinkingOllamaModel("deepseek-r1:14b")).toBe(true);
    expect(isLikelyThinkingOllamaModel("qwq:latest")).toBe(true);
  });

  it("does not flag typical instruct models", () => {
    expect(isLikelyThinkingOllamaModel("qwen2.5:14b-instruct")).toBe(false);
    expect(isLikelyThinkingOllamaModel("llama3.1:8b-instruct")).toBe(false);
  });
});

describe("effectiveOllamaJsonFormatForJudge", () => {
  it("uses explicit config over heuristic", () => {
    expect(
      effectiveOllamaJsonFormatForJudge({
        provider: "ollama",
        model: "deepseek-r1:14b",
        ollamaJsonFormat: true,
      }),
    ).toBe(true);
    expect(
      effectiveOllamaJsonFormatForJudge({
        provider: "ollama",
        model: "qwen2.5:14b-instruct",
        ollamaJsonFormat: false,
      }),
    ).toBe(false);
  });

  it("defaults heuristic when unset", () => {
    expect(
      effectiveOllamaJsonFormatForJudge({
        provider: "ollama",
        model: "deepseek-r1:14b",
      }),
    ).toBe(false);
    expect(
      effectiveOllamaJsonFormatForJudge({
        provider: "ollama",
        model: "qwen2.5:14b-instruct",
      }),
    ).toBe(true);
  });

  it("returns true for remote (hook ignored)", () => {
    expect(
      effectiveOllamaJsonFormatForJudge({
        provider: "remote",
        model: "gpt-4o",
        remoteBaseUrl: "https://api.openai.com/v1",
        remoteApiKey: "x",
      }),
    ).toBe(true);
  });
});
