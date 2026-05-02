import { VerifierError } from "../../shared/errors.js";

export type HttpIntegration = {
  get(
    url: string,
    init?: RequestInit,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    bodyText: string;
  }>;
};

export function createHttpIntegration(opts?: {
  allowHosts?: string[];
}): HttpIntegration {
  const allowHosts = new Set(
    (opts?.allowHosts ?? []).map((h) => h.toLowerCase()),
  );

  const assertAllowed = (urlStr: string) => {
    if (allowHosts.size === 0) return;
    const u = new URL(urlStr);
    if (!allowHosts.has(u.host.toLowerCase())) {
      throw new VerifierError(
        "POLICY_BLOCKED",
        `HTTP host not allowed by policy: ${u.host}`,
        {
          details: { host: u.host, allowHosts: [...allowHosts] },
        },
      );
    }
  };

  return {
    async get(url: string, init?: RequestInit) {
      assertAllowed(url);
      let res: Response;
      try {
        res = await fetch(url, { method: "GET", ...init });
      } catch (cause) {
        throw new VerifierError("TOOL_UNAVAILABLE", `HTTP GET failed: ${url}`, {
          cause,
        });
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) headers[k] = v;
      const bodyText = await res.text();
      return { status: res.status, headers, bodyText };
    },
  };
}
