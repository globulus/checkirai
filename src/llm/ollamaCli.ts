import { execFile } from "node:child_process";

export async function ollamaStopModel(opts: {
  host: string;
  model: string;
}): Promise<{ ok: boolean; error?: string }> {
  const model = String(opts.model ?? "").trim();
  if (!model) return { ok: true };

  return await new Promise((resolve) => {
    execFile(
      "ollama",
      ["stop", model],
      {
        env: {
          ...process.env,
          // Ollama CLI respects OLLAMA_HOST; allow http(s) URL per config.
          OLLAMA_HOST: opts.host,
        },
      },
      (err) => {
        if (!err) return resolve({ ok: true });
        const msg = err instanceof Error ? err.message : String(err);
        resolve({ ok: false, error: msg });
      },
    );
  });
}
