import { VerifierError } from "../../shared/errors.js";

/**
 * MVP placeholder for a Playwright MCP-backed browser integration.
 * The real implementation will call into an MCP client that can invoke the Playwright server tools.
 */
export type PlaywrightMcpIntegration = {
  kind: "playwright-mcp";
};

export function createPlaywrightMcpIntegration(_opts?: {
  serverName?: string;
}): PlaywrightMcpIntegration {
  // We don't have an MCP client in place yet. When wired, this adapter will map generic browser
  // capabilities to the concrete Playwright MCP tool calls.
  throw new VerifierError(
    "TOOL_UNAVAILABLE",
    "Playwright MCP integration not implemented yet.",
  );
}
