import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkOllamaRunning,
  listLocalModels,
  suggestModels,
} from "../src/llm/modelOps.js";

describe("ollama model ops", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checkOllamaRunning returns ok when /api/version succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/version")) {
          return new Response(JSON.stringify({ version: "0.1.0" }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const status = await checkOllamaRunning("http://127.0.0.1:11434");
    expect(status.ok).toBe(true);
    expect(status.version).toBe("0.1.0");
  });

  it("listLocalModels parses /api/tags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.1:8b-instruct",
                  model: "llama3.1:8b-instruct",
                  modified_at: "x",
                  size: 1,
                  digest: "d",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ version: "x" }), { status: 200 });
      }),
    );

    const models = await listLocalModels("http://127.0.0.1:11434");
    expect(models[0]?.name).toContain("llama3.1");
  });

  it("suggestModels returns curated tooling-capable models", () => {
    const models = suggestModels({ needTooling: true });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.capability.supportsJsonWell)).toBe(true);
  });
});
