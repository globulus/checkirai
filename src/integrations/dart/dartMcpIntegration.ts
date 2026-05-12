import { pathToFileURL } from "node:url";
import type { McpToolDescriptor } from "../../mcp/client.js";
import { McpToolClient } from "../../mcp/client.js";
import type { McpServerConfig } from "../../mcp/types.js";
import { VerifierError } from "../../shared/errors.js";

export type DartMcpIntegrationConfig = {
  server: McpServerConfig;
  /** Default project root for root-scoped tools (`file:` URI). */
  projectRoot?: string;
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

export function toFileUri(absPath: string): string {
  const uri = pathToFileURL(absPath).href;
  return uri.endsWith("/") ? uri.slice(0, -1) : uri;
}

export class DartMcpIntegration {
  private readonly client: McpToolClient;
  private readonly projectRoot?: string;
  private readonly registeredRoots = new Set<string>();
  private readonly launchedPids = new Set<number>();
  private connectedDtd = false;

  constructor(cfg: DartMcpIntegrationConfig) {
    this.client = new McpToolClient(cfg.server);
    if (cfg.projectRoot) this.projectRoot = cfg.projectRoot;
  }

  getLaunchedPids(): number[] {
    return [...this.launchedPids];
  }

  async close() {
    for (const pid of [...this.launchedPids]) {
      try {
        await this.stopApp(pid);
      } catch {
        // ignore best-effort cleanup
      }
    }
    await this.client.close();
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return await this.client.listTools();
  }

  async call(toolName: string, args: Record<string, unknown> = {}) {
    const res = await this.client.callTool(toolName, args);
    if (res.isError) {
      const details = extractText(res);
      throw new VerifierError(
        "TOOL_UNAVAILABLE",
        `dart-mcp tool failed: ${toolName}`,
        { details: { response: details } },
      );
    }
    return res;
  }

  async ensureRoot(fileUri?: string) {
    const root = (fileUri ?? this.projectRoot)?.trim();
    if (!root) {
      throw new VerifierError(
        "CONFIG_ERROR",
        "dart-mcp requires dartProjectRoot (file: URI) before root-scoped tools.",
      );
    }
    if (this.registeredRoots.has(root)) return root;
    await this.call("add_roots", { roots: [{ uri: root }] });
    this.registeredRoots.add(root);
    return root;
  }

  async listDevices() {
    return await this.call("list_devices", {});
  }

  async launchApp(opts: { root: string; device: string; target?: string }) {
    await this.ensureRoot(opts.root);
    const res = await this.call("launch_app", {
      root: opts.root,
      device: opts.device,
      ...(opts.target ? { target: opts.target } : {}),
    });
    const text = extractText(res);
    try {
      const parsed = JSON.parse(text) as { pid?: unknown; dtdUri?: unknown };
      if (typeof parsed.pid === "number") this.launchedPids.add(parsed.pid);
      return parsed;
    } catch {
      return { raw: text };
    }
  }

  async connectDtd(uri: string) {
    await this.call("connect_dart_tooling_daemon", { uri });
    this.connectedDtd = true;
  }

  async stopApp(pid: number) {
    await this.call("stop_app", { pid });
    this.launchedPids.delete(pid);
  }

  isDtdConnected() {
    return this.connectedDtd;
  }
}
