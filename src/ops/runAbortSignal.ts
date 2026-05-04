/**
 * Combines optional max-run deadline with an optional user interrupt signal
 * (e.g. CLI SIGINT) for cooperative cancellation.
 */
export function createRunAbortSignal(opts: {
  maxRunMs?: number;
  userSignal?: AbortSignal;
}): { signal: AbortSignal | undefined; dispose: () => void } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const parts: AbortSignal[] = [];

  if (typeof opts.maxRunMs === "number" && opts.maxRunMs > 0) {
    const c = new AbortController();
    const t = setTimeout(() => {
      c.abort();
    }, opts.maxRunMs);
    timers.push(t);
    parts.push(c.signal);
  }
  if (opts.userSignal) parts.push(opts.userSignal);

  const dispose = () => {
    for (const t of timers) clearTimeout(t);
  };

  if (parts.length === 0) return { signal: undefined, dispose };
  if (parts.length === 1) return { signal: parts[0], dispose };
  return { signal: AbortSignal.any(parts), dispose };
}
