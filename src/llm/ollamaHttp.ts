import { performance } from "node:perf_hooks";
import pino from "pino";
import { VerifierError } from "../shared/errors.js";

export type OllamaVersion = { version: string };

export type OllamaTag = {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: Record<string, unknown>;
};

export type OllamaTagsResponse = { models: OllamaTag[] };

export type OllamaPullProgress =
  | { status: string }
  | { status: string; digest: string; total: number; completed: number };

export type OllamaGenerateRequest = {
  model: string;
  prompt: string;
  system?: string;
  stream?: boolean;
  format?: "json";
  options?: Record<string, unknown>;
};

export type OllamaGenerateResponse = {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  done_reason?: string;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

function extractOllamaErrorMessage(bodyText: string): string | null {
  const trimmed = bodyText.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const err = (parsed as Record<string, unknown>).error;
      if (typeof err === "string" && err.trim()) return err.trim();
    }
  } catch {
    // ignore
  }
  // Ollama sometimes returns plain text errors.
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  return firstLine && firstLine.trim() ? firstLine.trim() : null;
}

function summarizeGenerateRequest(
  req: OllamaGenerateRequest,
): Record<string, unknown> {
  return {
    model: req.model,
    promptChars: req.prompt.length,
    hasSystem: typeof req.system === "string" && req.system.length > 0,
    format: req.format,
    stream: req.stream,
    optionKeys: req.options ? Object.keys(req.options) : [],
  };
}

const logger = pino({ name: "checkirai-ollama" });

function truncate(
  s: string,
  max: number,
): { text: string; truncated: boolean } {
  if (max <= 0) return { text: "", truncated: s.length > 0 };
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…(truncated)`, truncated: true };
}

async function safeJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      "Invalid JSON response from Ollama.",
      {
        cause,
        details: { status: res.status, bodyPreview: text.slice(0, 500) },
      },
    );
  }
}

export async function ollamaGetVersion(host: string): Promise<OllamaVersion> {
  const url = joinUrl(host, "api/version");
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (cause) {
    throw new VerifierError(
      "OLLAMA_NOT_RUNNING",
      `Cannot reach Ollama at ${host}.`,
      {
        cause,
        details: { host },
      },
    );
  }
  if (!res.ok) {
    throw new VerifierError(
      "OLLAMA_NOT_RUNNING",
      `Ollama not healthy at ${host} (HTTP ${res.status}).`,
      {
        details: { host, status: res.status },
      },
    );
  }
  return safeJson<OllamaVersion>(res);
}

export async function ollamaListTags(
  host: string,
): Promise<OllamaTagsResponse> {
  const url = joinUrl(host, "api/tags");
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (cause) {
    throw new VerifierError(
      "OLLAMA_NOT_RUNNING",
      `Cannot reach Ollama at ${host}.`,
      {
        cause,
        details: { host },
      },
    );
  }
  if (!res.ok) {
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      `Failed to list Ollama models (HTTP ${res.status}).`,
      {
        details: { host, status: res.status },
      },
    );
  }
  return safeJson<OllamaTagsResponse>(res);
}

export async function* ollamaPullModelStream(
  host: string,
  modelName: string,
): AsyncGenerator<OllamaPullProgress> {
  const url = joinUrl(host, "api/pull");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true }),
    });
  } catch (cause) {
    throw new VerifierError(
      "OLLAMA_NOT_RUNNING",
      `Cannot reach Ollama at ${host}.`,
      {
        cause,
        details: { host },
      },
    );
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      `Failed to pull model ${modelName} (HTTP ${res.status}).`,
      {
        details: { host, status: res.status, bodyPreview: body.slice(0, 500) },
      },
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as OllamaPullProgress;
      } catch {
        // Ignore malformed progress lines; keep streaming.
      }
    }
  }
}

export async function ollamaGenerate(
  host: string,
  req: OllamaGenerateRequest,
): Promise<OllamaGenerateResponse> {
  const url = joinUrl(host, "api/generate");
  const trace =
    process.env.CHECKIRAI_LOG_LLM === "1" ||
    process.env.CHECKIRAI_LOG_LLM === "true";
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...req, stream: false }),
    });
  } catch (cause) {
    throw new VerifierError(
      "OLLAMA_NOT_RUNNING",
      `Cannot reach Ollama at ${host}.`,
      {
        cause,
        details: { host },
      },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const upstreamError = extractOllamaErrorMessage(body);
    if (trace) {
      logger.error(
        {
          host,
          url,
          status: res.status,
          request: summarizeGenerateRequest(req),
          upstreamError,
        },
        "ollama.generate failed",
      );
    }
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      upstreamError
        ? `Ollama generate failed (HTTP ${res.status}): ${upstreamError}`
        : `Ollama generate failed (HTTP ${res.status}).`,
      {
        details: {
          host,
          status: res.status,
          request: summarizeGenerateRequest(req),
          bodyPreview: body.slice(0, 2000),
        },
      },
    );
  }
  const out = await safeJson<OllamaGenerateResponse>(res);
  if (trace) {
    const durMs = Math.max(0, Math.round(performance.now() - t0));
    const promptPreview = truncate(req.prompt, 1200);
    const responsePreview = truncate(out.response, 1200);
    logger.info(
      {
        host,
        model: req.model,
        durationMs: durMs,
        request: summarizeGenerateRequest(req),
        promptPreview: promptPreview.text,
        responsePreview: responsePreview.text,
        truncated: {
          prompt: promptPreview.truncated,
          response: responsePreview.truncated,
        },
        done: out.done,
        done_reason: out.done_reason,
        total_duration: out.total_duration,
        load_duration: out.load_duration,
        prompt_eval_count: out.prompt_eval_count,
        eval_count: out.eval_count,
      },
      "ollama.generate",
    );
  }
  return out;
}
