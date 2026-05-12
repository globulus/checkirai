export function extractMcpText(res: unknown): string {
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

export function tryParseJsonFence(text: string): unknown | undefined {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const payload = m?.[1]?.trim();
  if (!payload) return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}
