#!/usr/bin/env node
/**
 * MCP server entrypoint (stdio). From the repo root: `pnpm mcp` (terminal),
 * or in Cursor prefer an absolute path to `dist/src/interfaces/mcp/bin.js` (after `pnpm build`;
 * some hosts ignore `cwd` for relative args)
 * or `pnpm --silent mcp` so nothing else writes to stdout (MCP JSON-RPC only).
 */
import { startMcpServer } from "./server.js";

const outDir =
  typeof process.env.CHECKIRAI_OUT === "string" &&
  process.env.CHECKIRAI_OUT.trim()
    ? process.env.CHECKIRAI_OUT.trim()
    : undefined;

void startMcpServer(outDir ? { outDir } : undefined).catch((err) => {
  console.error(err);
  process.exit(1);
});
