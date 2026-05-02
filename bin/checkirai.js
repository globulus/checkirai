#!/usr/bin/env node
/**
 * Published CLI entrypoint.
 *
 * This stays as plain JS so package managers can execute it directly via `bin`
 * without requiring tsx/ts-node. It delegates to the compiled output in `dist/`.
 */

const entry = new URL("../dist/src/interfaces/cli/bin.js", import.meta.url);

try {
  await import(entry.href);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("Failed to start checkirai CLI. Did you run `pnpm build`?\n");
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}
