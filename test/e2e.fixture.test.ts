import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "../fixtures/webapp/server.js";
import { buildCapabilityGraph } from "../src/capabilities/registry.js";
import { verify } from "../src/core/verify.js";
import { createFsIntegration } from "../src/integrations/fs/fsIntegration.js";
import { createHttpIntegration } from "../src/integrations/http/httpIntegration.js";
import { normalizeMarkdownToSpecIR } from "../src/spec/normalize.js";

describe("e2e (no browser)", () => {
  let url = "";
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const s = await startFixtureServer(31337);
    url = s.url;
    close = s.close;
  });

  afterAll(async () => {
    await close?.();
  });

  it("runs verification end-to-end with http/fs integrations", async () => {
    const spec = normalizeMarkdownToSpecIR("- The page has a “Sign in” button");
    // Add an observable that can be checked without browser (HTTP contains)
    const firstReq = spec.requirements[0];
    if (!firstReq) throw new Error("Expected at least one requirement");
    spec.requirements[0] = {
      ...firstReq,
      expected_observables: [
        { kind: "http_response", url, pattern: "Sign in" },
      ],
    };

    const cap = buildCapabilityGraph({ enable: { fs: true, http: true } });
    const result = await verify({
      spec,
      target: { baseUrl: url },
      capabilities: cap.capabilities,
      integrations: {
        fs: createFsIntegration(),
        http: createHttpIntegration(),
      },
      constraints: { outDir: ".verifier-test", policyName: "read_only" },
    });
    expect(result.overall_status).toBeDefined();
  });
});
