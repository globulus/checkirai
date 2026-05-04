import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { extname, join } from "node:path";
import { URL } from "node:url";
import pino from "pino";
import { buildCapabilityGraph } from "../../capabilities/registry.js";
import {
  loadProjectConfig,
  mergeLlmPolicyWithProjectProfile,
} from "../../config/projectConfig.js";
import { LlmPolicySchema, summarizeLlmPolicyForRun } from "../../llm/types.js";
import {
  chromeDevtoolsListTools,
  chromeDevtoolsSelfCheck,
  createOpsContext,
  explainFailure,
  getArtifact,
  getRunGraph,
  modelCatalog,
  modelEnsure,
  modelList,
  modelPull,
  modelSuggest,
  ollamaDaemonStart,
  ollamaDaemonStatus,
  ollamaDaemonStop,
  ollamaStatus,
  RestartFromPhaseSchema,
  type VerifySpecInput,
  verifySpec,
} from "../../ops/index.js";
import {
  insertRunIfMissing,
  listRuns,
} from "../../persistence/repo/runRepo.js";
import { planProbes } from "../../planners/planner.js";
import { VerifierError } from "../../shared/errors.js";
import { SpecBundleSchema } from "../../spec/bundle.js";
import { SpecIRSchema } from "../../spec/ir.js";
import { normalizeMarkdownToSpecIR } from "../../spec/normalize.js";

type Json = Record<string, unknown>;

function errForLog(e: unknown): Record<string, unknown> {
  if (e instanceof VerifierError) {
    return {
      name: e.name,
      code: e.code,
      message: e.message,
      details: e.details,
      cause: e.cause,
      stack: e.stack,
    };
  }
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { message: String(e) };
}

function splitCmdline(s: string): { command: string; args: string[] } {
  // Minimal splitter: supports quoted segments; good enough for typical mcp.json.
  const args: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) args.push(cur);
  const command = args.shift() ?? "";
  return { command, args };
}

function readCursorMcpServer(name: string): {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
} | null {
  try {
    const p = join(os.homedir(), ".cursor", "mcp.json");
    const txt = readFileSync(p, "utf8");
    const obj = JSON.parse(txt) as {
      mcpServers?: Record<
        string,
        {
          command?: unknown;
          args?: unknown;
          cwd?: unknown;
          env?: unknown;
          type?: unknown;
        }
      >;
    };
    const entry = obj.mcpServers?.[name];
    if (!entry) return null;
    const cmdRaw = typeof entry.command === "string" ? entry.command : "";
    if (!cmdRaw) return null;

    const argsRaw = Array.isArray(entry.args)
      ? entry.args.filter((x): x is string => typeof x === "string")
      : [];

    // Some configs put the whole commandline in `command` (e.g. "npx foo@latest").
    const split =
      cmdRaw.includes(" ") && argsRaw.length === 0
        ? splitCmdline(cmdRaw)
        : null;
    const command = split ? split.command : cmdRaw;
    const args = split ? split.args : argsRaw;

    const cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
    const envEntries =
      entry.env && typeof entry.env === "object"
        ? (Object.entries(entry.env as Record<string, unknown>).filter(
            (pair): pair is [string, string] => typeof pair[1] === "string",
          ) as Array<[string, string]>)
        : [];
    const env = envEntries.length ? Object.fromEntries(envEntries) : undefined;

    return {
      command,
      ...(args.length ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(env && Object.keys(env).length ? { env } : {}),
    };
  } catch {
    return null;
  }
}

function sendJson(res: http.ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body ?? null);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
  });
  res.end(json);
}

function sendText(res: http.ServerResponse, code: number, text: string) {
  res.writeHead(code, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req)
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function guessContentType(path: string) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".json":
      return "application/json; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

export function startWebDashboardServer(opts?: {
  port?: number;
  host?: string;
  outRoot?: string;
  serveStaticFrom?: string;
}) {
  const port = opts?.port ?? 8787;
  const host = opts?.host ?? "127.0.0.1";
  const ctx = createOpsContext({ outRoot: opts?.outRoot ?? ".verifier" });
  const logger = pino({ name: "checkirai-web" });
  const projectCfg = loadProjectConfig();

  const runningJobs = new Map<string, Promise<unknown>>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const { pathname } = url;

      // CORS (local dev convenience)
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // --- API ---
      if (pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/project-config" && req.method === "GET") {
        sendJson(res, 200, {
          ok: Boolean(projectCfg.config),
          path: projectCfg.path,
          config: projectCfg.config,
        });
        return;
      }

      if (pathname === "/api/mcp/chrome-devtools" && req.method === "GET") {
        const cfg =
          projectCfg.config?.mcpServers?.["chrome-devtools"] ??
          readCursorMcpServer("chrome-devtools");
        sendJson(res, 200, { ok: Boolean(cfg), server: cfg });
        return;
      }

      if (pathname === "/api/runs" && req.method === "GET") {
        const limit = url.searchParams.get("limit");
        const rows = listRuns(ctx.db, { limit: limit ? Number(limit) : 50 });
        sendJson(res, 200, { runs: rows });
        return;
      }

      const runGraphMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runGraphMatch && req.method === "GET") {
        const runId = decodeURIComponent(runGraphMatch[1] ?? "");
        const graph = getRunGraph(ctx, { runId });
        sendJson(res, 200, graph);
        return;
      }

      const sseMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (sseMatch && req.method === "GET") {
        const runId = decodeURIComponent(sseMatch[1] ?? "");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write("\n");

        const send = (event: unknown) => {
          res.write(`event: message\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        // replay buffered events
        for (const e of ctx.events.getBuffered(runId)) send(e);

        const subId = randomUUID();
        const unsub = ctx.events.subscribe(runId, subId, (e) => send(e));

        const keepAlive = setInterval(() => {
          res.write(`event: ping\ndata: {}\n\n`);
        }, 15000);

        req.on("close", () => {
          clearInterval(keepAlive);
          unsub();
        });
        return;
      }

      if (pathname.startsWith("/api/commands/") && req.method === "POST") {
        const name = decodeURIComponent(
          pathname.slice("/api/commands/".length),
        );
        const body = (await readJsonBody(req)) as Json;

        if (name === "verify_spec") {
          const runId = randomUUID();
          const llmPolicy = mergeLlmPolicyWithProjectProfile(
            LlmPolicySchema.parse(body.llm ?? projectCfg.config?.llm ?? {}),
            projectCfg.config ?? undefined,
          );
          const llmRow = summarizeLlmPolicyForRun(llmPolicy);
          // Insert the run row immediately so the client can fetch it even while
          // long-running work (spec normalization / planning / execution) is happening.
          insertRunIfMissing(ctx.db, {
            id: runId,
            created_at: new Date().toISOString(),
            target_base_url: String(body.targetUrl ?? ""),
            policy_name: null,
            llm_provider: llmRow.llm_provider,
            llm_model: llmRow.llm_model,
            status: "running",
            confidence: null,
            summary_md_path: null,
            report_json_path: null,
            parent_run_id: null,
            restart_from_phase: null,
          });

          // Fire-and-forget background job; UI watches SSE + run graph.
          const verifyInput: VerifySpecInput = {
            targetUrl: String(body.targetUrl ?? ""),
            ...(typeof body.tools === "string"
              ? { tools: body.tools }
              : projectCfg.config?.defaults?.tools
                ? { tools: projectCfg.config.defaults.tools }
                : {}),
            ...(typeof body.outDir === "string" ? { outDir: body.outDir } : {}),
            ...(body.llm
              ? {
                  llm: mergeLlmPolicyWithProjectProfile(
                    LlmPolicySchema.parse(body.llm),
                    projectCfg.config ?? undefined,
                  ),
                }
              : {}),
            ...(typeof body.specMarkdown === "string"
              ? { specMarkdown: body.specMarkdown }
              : {}),
            ...(body.spec ? { spec: SpecIRSchema.parse(body.spec) } : {}),
            ...(body.specBundle
              ? { specBundle: SpecBundleSchema.parse(body.specBundle) }
              : {}),
            ...(() => {
              const cds = body.chromeDevtoolsServer as unknown;
              const cdsObj =
                cds && typeof cds === "object"
                  ? (cds as Record<string, unknown>)
                  : null;
              const command =
                cdsObj && typeof cdsObj.command === "string"
                  ? cdsObj.command
                  : null;
              if (!command) return {};

              const args =
                cdsObj && Array.isArray(cdsObj.args)
                  ? (cdsObj.args.filter(
                      (x) => typeof x === "string",
                    ) as string[])
                  : undefined;
              const cwd =
                cdsObj && typeof cdsObj.cwd === "string"
                  ? cdsObj.cwd
                  : undefined;

              return {
                chromeDevtoolsServer: {
                  command,
                  ...(args ? { args } : {}),
                  ...(cwd ? { cwd } : {}),
                },
              };
            })(),
            ...(typeof body.restartFromRunId === "string" &&
            body.restartFromRunId.trim()
              ? { restartFromRunId: body.restartFromRunId.trim() }
              : {}),
            ...(typeof body.restartFromPhase === "string" &&
            body.restartFromPhase.trim()
              ? {
                  restartFromPhase: RestartFromPhaseSchema.parse(
                    body.restartFromPhase.trim(),
                  ),
                }
              : {}),
          };

          // Validate chrome-devtools configuration early to avoid crashing the API server
          // on an unhandled async rejection.
          const toolsStr = String(verifyInput.tools ?? "");
          const wantsChromeDevtools = toolsStr
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .includes("chrome-devtools");
          if (wantsChromeDevtools && !verifyInput.chromeDevtoolsServer) {
            const fallback =
              projectCfg.config?.mcpServers?.["chrome-devtools"] ??
              readCursorMcpServer("chrome-devtools");
            if (fallback) {
              verifyInput.chromeDevtoolsServer = {
                command: fallback.command,
                ...(fallback.args ? { args: fallback.args } : {}),
                ...(fallback.cwd ? { cwd: fallback.cwd } : {}),
                ...(fallback.env ? { env: fallback.env } : {}),
              };
            }
          }
          if (wantsChromeDevtools && !verifyInput.chromeDevtoolsServer) {
            sendJson(res, 400, {
              ok: false,
              error:
                "tools includes 'chrome-devtools' but chromeDevtoolsServer is missing (command/args/cwd).",
              runId,
            });
            return;
          }

          const job = verifySpec(ctx, verifyInput, { runId })
            .then((x) => x.result)
            .catch((err) => {
              logger.error(
                { err, runId },
                "verify_spec failed before producing a report",
              );
              return null;
            });

          runningJobs.set(runId, job);
          job.finally(() => runningJobs.delete(runId));

          sendJson(res, 202, { ok: true, runId });
          return;
        }

        if (name === "ollama_status") {
          const out = await ollamaStatus(ctx, {
            ...(typeof body.host === "string" ? { host: body.host } : {}),
          });
          sendJson(res, 200, out);
          return;
        }
        if (name === "model_list") {
          const out = await modelList(ctx, {
            ...(typeof body.host === "string" ? { host: body.host } : {}),
          });
          sendJson(res, 200, out);
          return;
        }
        if (name === "model_catalog") {
          const out = await modelCatalog(ctx, {
            ...(typeof body.host === "string" ? { host: body.host } : {}),
            ...(typeof body.requireTooling === "boolean"
              ? { requireTooling: body.requireTooling }
              : {}),
          });
          sendJson(res, 200, out);
          return;
        }
        if (name === "model_suggest") {
          const out = modelSuggest(ctx, {
            requireTooling: Boolean(body.requireTooling ?? true),
          });
          sendJson(res, 200, out);
          return;
        }
        if (name === "model_pull") {
          const out = await modelPull(ctx, {
            ...(typeof body.host === "string" ? { host: body.host } : {}),
            modelName: String(body.modelName ?? ""),
          });
          sendJson(res, 200, out);
          return;
        }
        if (name === "model_ensure") {
          const out = await modelEnsure(ctx, {
            ...(body.llm
              ? {
                  llm: mergeLlmPolicyWithProjectProfile(
                    LlmPolicySchema.parse(body.llm),
                    projectCfg.config ?? undefined,
                  ),
                }
              : {}),
          });
          sendJson(res, 200, out);
          return;
        }

        if (name === "ollama_daemon_status") {
          const out = ollamaDaemonStatus(ctx);
          sendJson(res, 200, out);
          return;
        }
        if (name === "ollama_daemon_start") {
          const out = await ollamaDaemonStart(ctx, {
            ...(typeof body.host === "string" ? { host: body.host } : {}),
          });
          sendJson(res, 200, out);
          return;
        }
        if (name === "ollama_daemon_stop") {
          const out = await ollamaDaemonStop(ctx);
          sendJson(res, 200, out);
          return;
        }

        if (name === "explain_failure") {
          const out = explainFailure(ctx, {
            runId: String(body.runId ?? ""),
            requirementId: String(body.requirementId ?? ""),
          });
          sendJson(res, 200, out);
          return;
        }
        if (name === "get_artifact") {
          const out = getArtifact(ctx, {
            runId: String(body.runId ?? ""),
            artifactId: String(body.artifactId ?? ""),
          });
          sendJson(res, 200, out);
          return;
        }

        if (name === "list_capabilities") {
          const toolSet = new Set(
            String(body.tools ?? "fs,http")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          const capGraph = buildCapabilityGraph({
            enable: {
              playwrightMcp:
                toolSet.has("playwright-mcp") || toolSet.has("chrome-devtools"),
              shell: toolSet.has("shell"),
              fs: toolSet.has("fs"),
              http: toolSet.has("http"),
            },
          });
          sendJson(res, 200, {
            capabilities: [...capGraph.capabilities.values()],
          });
          return;
        }

        if (name === "suggest_probe_plan") {
          const specIr =
            typeof body.specMarkdown === "string"
              ? normalizeMarkdownToSpecIR(body.specMarkdown)
              : SpecIRSchema.parse(body.spec ?? {});
          const toolSet = new Set(
            String(body.tools ?? "fs,http")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          const capGraph = buildCapabilityGraph({
            enable: {
              playwrightMcp:
                toolSet.has("playwright-mcp") || toolSet.has("chrome-devtools"),
              shell: toolSet.has("shell"),
              fs: toolSet.has("fs"),
              http: toolSet.has("http"),
            },
          });
          const plan = planProbes(specIr, capGraph.capabilities);
          sendJson(res, 200, plan);
          return;
        }

        if (name === "chrome_devtools_list_tools") {
          const out = await chromeDevtoolsListTools(ctx, {
            command: String(body.command ?? ""),
            ...(Array.isArray(body.args)
              ? { args: body.args as string[] }
              : {}),
            ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
          });
          sendJson(res, 200, out);
          return;
        }

        if (name === "chrome_devtools_self_check") {
          const out = await chromeDevtoolsSelfCheck(ctx, {
            command: String(body.command ?? ""),
            ...(Array.isArray(body.args)
              ? { args: body.args as string[] }
              : {}),
            ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
          });
          sendJson(res, 200, out);
          return;
        }

        sendJson(res, 404, { ok: false, error: `Unknown command: ${name}` });
        return;
      }

      // --- Static (production) ---
      const staticRoot = opts?.serveStaticFrom;
      if (staticRoot) {
        const safePath = pathname === "/" ? "/index.html" : pathname;
        const filePath = join(staticRoot, safePath);
        if (existsSync(filePath)) {
          res.writeHead(200, { "content-type": guessContentType(filePath) });
          createReadStream(filePath).pipe(res);
          return;
        }
        // SPA fallback
        const indexPath = join(staticRoot, "index.html");
        if (existsSync(indexPath)) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(readFileSync(indexPath, "utf8"));
          return;
        }
      }

      sendText(res, 404, "Not found");
    } catch (e: unknown) {
      logger.error(
        {
          method: req.method,
          url: req.url,
          err: errForLog(e),
        },
        "Unhandled API server error",
      );
      const err = e as { message?: unknown };
      const code = e instanceof VerifierError ? e.code : undefined;
      sendJson(res, 500, {
        ok: false,
        ...(code ? { code } : {}),
        error: typeof err?.message === "string" ? err.message : String(e),
      });
    }
  });

  server.listen(port, host, () => {
    logger.info({ host, port }, "Web dashboard server listening.");
  });

  return {
    server,
    ctx,
    runningJobs,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
