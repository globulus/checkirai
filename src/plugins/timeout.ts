import { VerifierError } from "../shared/errors.js";

export async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (!timeoutMs) return await p;
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new VerifierError(
              "TIMEOUT",
              `Timed out after ${timeoutMs}ms: ${label}`,
              {
                details: { timeoutMs, label },
              },
            ),
          ),
        timeoutMs,
      ),
    ),
  ]);
}
