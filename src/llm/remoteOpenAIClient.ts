import { VerifierError } from "../shared/errors.js";

export type RemoteChatRequest = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
};

export async function remoteChatCompletion(
  req: RemoteChatRequest,
): Promise<{ content: string }> {
  const url = new URL("/v1/chat/completions", req.baseUrl).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
      }),
    });
  } catch (cause) {
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      "Remote LLM request failed.",
      { cause },
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      `Remote LLM error (HTTP ${res.status}).`,
      {
        details: { status: res.status, bodyPreview: text.slice(0, 500) },
      },
    );
  }
  type OpenAIChatResponse = {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const json = JSON.parse(text) as OpenAIChatResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new VerifierError(
      "LLM_PROVIDER_ERROR",
      "Remote LLM response missing message content.",
      {
        details: { bodyPreview: text.slice(0, 500) },
      },
    );
  }
  return { content };
}
