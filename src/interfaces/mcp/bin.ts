#!/usr/bin/env node
/**
 * MCP server entrypoint (stdio). Use `pnpm mcp` from the repo root, or point
 * Cursor’s MCP config at this file via `pnpm exec` / `node --import tsx`.
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
