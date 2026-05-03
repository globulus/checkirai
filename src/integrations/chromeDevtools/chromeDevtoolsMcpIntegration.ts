import type { ArtifactStore } from "../../artifacts/store.js";
import type { ArtifactRef } from "../../artifacts/types.js";
import { McpToolClient, type McpToolDescriptor } from "../../mcp/client.js";
import type { McpServerConfig } from "../../mcp/types.js";
import { VerifierError } from "../../shared/errors.js";

export type ChromeDevtoolsIntegrationConfig = {
  server: McpServerConfig;
  /** If set, select this page id before actions. */
  pageId?: string;
};

export type ChromeSnapshot = {
  snapshotText: string;
};

function extractText(res: unknown): string {
  const r = res as {
    structuredContent?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  if (typeof r.structuredContent === "string") return r.structuredContent;
  const text = r.content
    ?.map((c) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
  if (typeof text === "string" && text.trim()) return text;
  return JSON.stringify(res, null, 2);
}

export class ChromeDevtoolsMcpIntegration {
  private readonly client: McpToolClient;
  private readonly pageId?: string;
  private didAutoSelectPage = false;

  constructor(cfg: ChromeDevtoolsIntegrationConfig) {
    this.client = new McpToolClient(cfg.server);
    if (cfg.pageId) this.pageId = cfg.pageId;
  }

  async close() {
    await this.client.close();
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return await this.client.listTools();
  }

  /**
   * Generic passthrough: allows using any tool exposed by user-chrome-devtools.
   * This is what makes the integration “complete” even as the MCP adds new tools.
   */
  async call(toolName: string, args: Record<string, unknown> = {}) {
    await this.ensurePageSelected();
    const res = await this.client.callTool(toolName, args);
    if (res.isError) {
      const details = extractText(res);
      throw new VerifierError(
        "TOOL_UNAVAILABLE",
        `chrome-devtools tool failed: ${toolName}`,
        { details: { response: details } },
      );
    }
    return res;
  }

  private extractFirstPageId(res: unknown): string | undefined {
    // Prefer structured content if available.
    const r = res as { structuredContent?: unknown; content?: unknown };
    const sc = r?.structuredContent as unknown;

    const tryFrom = (v: unknown): string | undefined => {
      if (!v) return undefined;
      if (Array.isArray(v)) {
        const first = v[0] as Record<string, unknown> | undefined;
        const id =
          (first?.id as string | undefined) ??
          (first?.pageId as string | undefined) ??
          (first?.targetId as string | undefined);
        return typeof id === "string" && id.trim() ? id : undefined;
      }
      if (typeof v === "object") {
        const obj = v as Record<string, unknown>;
        const pages = obj.pages ?? obj.targets ?? obj.items;
        return tryFrom(pages);
      }
      return undefined;
    };

    const fromStructured = tryFrom(sc);
    if (fromStructured) return fromStructured;

    // Fallback: parse the text payload if it looks like JSON.
    const text = extractText(res);
    try {
      const parsed = JSON.parse(text) as unknown;
      return tryFrom(parsed);
    } catch {
      return undefined;
    }
  }

  async ensurePageSelected() {
    if (this.pageId) {
      await this.client.callTool("select_page", { pageId: this.pageId });
      return;
    }
    if (this.didAutoSelectPage) return;

    // Best-effort: pick the first open page so actions like `take_snapshot`
    // don't fail with "no selected page".
    const pagesRes = await this.client.callTool("list_pages", {});
    const firstPageId = this.extractFirstPageId(pagesRes);
    if (firstPageId) {
      await this.client.callTool("select_page", { pageId: firstPageId });
      this.didAutoSelectPage = true;
    }
  }

  async navigate(url: string) {
    // Fast path: navigate current page.
    await this.call("navigate_page", { type: "url", url });
  }

  /** Best-effort current page URL via `evaluate_script` (for deterministic `url_matches`). */
  async getCurrentUrl(): Promise<string | undefined> {
    try {
      const res = await this.call("evaluate_script", {
        function: "() => location.href",
      });
      const t = extractText(res).trim();
      const quoted = t.match(
        /"((?:https?:\/\/|file:\/\/)[^"\s]+)"|'((?:https?:\/\/|file:\/\/)[^'\s]+)'/,
      );
      if (quoted?.[1]) return quoted[1];
      if (quoted?.[2]) return quoted[2];
      if (/^https?:\/\//i.test(t)) return t.split(/\s+/)[0];
      return t.replace(/^[`'"]+|[`'"]+$/g, "").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async takeSnapshot(
    store: ArtifactStore,
  ): Promise<{ snapshot: ChromeSnapshot; artifact: ArtifactRef }> {
    const res = await this.call("take_snapshot", { verbose: false });
    const snapshotText = extractText(res);
    const artifact = store.writeText("a11y_snapshot", snapshotText, {
      ext: "txt",
    });
    return { snapshot: { snapshotText }, artifact };
  }

  async takeScreenshot(
    store: ArtifactStore,
    label?: string,
  ): Promise<ArtifactRef> {
    const res = await this.call("take_screenshot", {});
    // Some servers return base64. We store as JSON until we standardize.
    return store.writeJson(
      "screenshot",
      { label, response: res },
      { ext: "json" },
    );
  }

  /**
   * Find the first uid in the snapshot text whose line contains the given needle.
   * MVP heuristic; can be upgraded to a real snapshot parser.
   */
  findUid(snapshotText: string, needle: string): string | undefined {
    const lines = snapshotText.split(/\r?\n/);
    for (const line of lines) {
      if (!line.toLowerCase().includes(needle.toLowerCase())) continue;
      const m =
        line.match(/uid[:=]\s*([A-Za-z0-9_-]+)/i) ??
        line.match(/\buid\b.*?\b([A-Za-z0-9_-]{6,})\b/i);
      if (m?.[1]) return m[1];
    }
    return undefined;
  }

  async clickUid(uid: string) {
    await this.call("click", { uid });
  }

  async typeText(text: string) {
    await this.call("type_text", { text });
  }

  async fill(uid: string, value: string) {
    await this.call("fill", { uid, value });
  }
}
