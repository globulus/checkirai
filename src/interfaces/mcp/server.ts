import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pino from "pino";
import * as z from "zod/v4";
import { buildCapabilityGraph } from "../../capabilities/registry.js";
import { VerificationResultSchema } from "../../core/result.js";
import { LlmPolicySchema } from "../../llm/types.js";
import {
  createOpsContext,
  explainFailure,
  getArtifact,
  getReport,
  getRunGraph,
  modelEnsure,
  modelList,
  modelPull,
  modelSuggest,
  ollamaStatus,
  RestartFromPhaseSchema,
  type VerifySpecInput,
  verifySpec,
} from "../../ops/index.js";
import { planProbes } from "../../planners/planner.js";
import { ProbePlanSchema } from "../../planners/types.js";
import { SpecBundleSchema } from "../../spec/bundle.js";
import { SpecIRSchema } from "../../spec/ir.js";
import { getRun } from "../../persistence/repo/runRepo.js";
import { normalizeMarkdownToSpecIRWithLlm } from "../../spec/normalize.js";

/** MCP uses stdout for JSON-RPC only; logs must go to stderr. */
const logger = pino({ name: "checkirai-mcp" }, pino.destination(2));

export async function startMcpServer(opts?: { outDir?: string }) {
  const outRoot = opts?.outDir ?? ".verifier";
  const ctx = createOpsContext({ outRoot });

  const server = new McpServer(
    { name: "checkirai", version: "0.1.0" },
    {
      instructions:
        "Verify a target implementation against a spec: verify_spec for full runs, restart_verify_spec to continue from a prior run (spec_ir or llm_plan). Use ollama/model tools to manage local models.",
    },
  );

  server.registerTool(
    "list_capabilities",
    {
      description:
        "List verifier capability classes (based on enabled integrations).",
      inputSchema: {
        tools: z
          .string()
          .optional()
          .describe("Comma-separated: playwright-mcp,shell,fs,http"),
      },
      outputSchema: {
        capabilities: z.array(z.string()),
      },
    },
    async ({ tools }) => {
      const toolSet = new Set(
        String(tools ?? "fs,http")
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
      const structuredContent = {
        capabilities: [...capGraph.capabilities.values()],
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "ollama_status",
    {
      description: "Check whether Ollama is reachable and return basic status.",
      inputSchema: { host: z.string().optional() },
      outputSchema: {
        ok: z.boolean(),
        host: z.string(),
        version: z.string().optional(),
        error: z
          .object({
            code: z.string(),
            message: z.string(),
          })
          .optional(),
      },
    },
    async ({ host }) => {
      const status = await ollamaStatus(ctx, {
        host: host ?? "http://127.0.0.1:11434",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    },
  );

  server.registerTool(
    "model_list",
    {
      description: "List installed Ollama models.",
      inputSchema: { host: z.string().optional() },
      outputSchema: { models: z.array(z.object({ name: z.string() })) },
    },
    async ({ host }) => {
      const structuredContent = await modelList(ctx, {
        host: host ?? "http://127.0.0.1:11434",
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "model_suggest",
    {
      description:
        "Suggest recommended models for tool-driving structured output.",
      inputSchema: { requireTooling: z.boolean().optional() },
      outputSchema: {
        models: z.array(
          z.object({ name: z.string(), notes: z.string().optional() }),
        ),
      },
    },
    async ({ requireTooling }) => {
      const structuredContent = modelSuggest(ctx, {
        requireTooling: requireTooling ?? true,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "model_pull",
    {
      description: "Pull (download) an Ollama model.",
      inputSchema: { host: z.string().optional(), modelName: z.string() },
      outputSchema: { ok: z.boolean(), modelName: z.string() },
    },
    async ({ host, modelName }) => {
      const structuredContent = await modelPull(ctx, {
        host: host ?? "http://127.0.0.1:11434",
        modelName,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "model_ensure",
    {
      description: "Ensure a usable Ollama model is available (may auto-pull).",
      inputSchema: {
        llm: z
          .any()
          .optional()
          .describe("LlmPolicy object (provider must be ollama)"),
      },
      outputSchema: { selectedModel: z.string(), pulled: z.boolean() },
    },
    async ({ llm }) => {
      const out = await modelEnsure(ctx, {
        llm: LlmPolicySchema.parse(llm ?? { provider: "ollama" }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    },
  );

  server.registerTool(
    "suggest_probe_plan",
    {
      description: "Plan probes for a spec without executing them.",
      inputSchema: {
        specMarkdown: z.string().optional(),
        spec: SpecIRSchema.optional(),
        tools: z.string().optional(),
        llm: LlmPolicySchema.optional(),
      },
      outputSchema: ProbePlanSchema,
    },
    async ({ specMarkdown, spec, tools, llm }) => {
      const llmPolicy = LlmPolicySchema.parse(llm ?? { provider: "ollama" });
      const specIr = specMarkdown
        ? await normalizeMarkdownToSpecIRWithLlm(specMarkdown, llmPolicy)
        : SpecIRSchema.parse(spec ?? {});
      const toolSet = new Set(
        String(tools ?? "fs,http")
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
      return {
        content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
        structuredContent: plan,
      };
    },
  );

  server.registerTool(
    "restart_verify_spec",
    {
      description:
        "Start a new verification run that reuses artifacts from a parent run: restart from phase spec_ir (skip spec normalization) or llm_plan (reuse spec IR and replan). Inherits target URL and LLM defaults from the parent when omitted.",
      inputSchema: {
        parentRunId: z
          .string()
          .describe(
            "Completed parent run UUID (same as restartFromRunId on verify_spec).",
          ),
        restartFromPhase: z
          .enum(["spec_ir", "llm_plan"])
          .describe(
            "spec_ir: reuse saved Spec IR from parent; llm_plan: reuse Spec IR and run planning/execution again (requires chrome-devtools + LLM, same as verify_spec).",
          ),
        targetUrl: z
          .string()
          .optional()
          .describe("Override target; default is parent run target_base_url."),
        tools: z.string().optional(),
        outDir: z.string().optional(),
        llm: LlmPolicySchema.optional().describe(
          "Override LLM policy; default is inferred from parent run (ollama model/host defaults).",
        ),
        chromeDevtoolsServer: z
          .object({
            command: z.string(),
            args: z.array(z.string()).optional(),
            cwd: z.string().optional(),
          })
          .optional(),
      },
      outputSchema: VerificationResultSchema,
    },
    async ({
      parentRunId,
      restartFromPhase,
      targetUrl,
      tools,
      outDir,
      llm,
      chromeDevtoolsServer,
    }) => {
      const parentId = parentRunId.trim();
      const parent = getRun(ctx.db, parentId);
      if (!parent) {
        throw new Error(`Unknown parent runId: ${parentId}`);
      }
      const phase = RestartFromPhaseSchema.parse(restartFromPhase);
      const effectiveTarget = (
        targetUrl?.trim() || parent.target_base_url
      ).trim();
      if (!effectiveTarget) {
        throw new Error(
          "Parent run has no target_base_url; pass targetUrl explicitly.",
        );
      }
      const llmPolicy = llm
        ? LlmPolicySchema.parse(llm)
        : LlmPolicySchema.parse({
            provider:
              parent.llm_provider === "remote" ||
              parent.llm_provider === "none" ||
              parent.llm_provider === "ollama"
                ? parent.llm_provider
                : "ollama",
            ollamaModel:
              parent.llm_provider === "ollama" && parent.llm_model
                ? parent.llm_model
                : "auto",
          });

      const verifyInput = {
        targetUrl: effectiveTarget,
        tools: tools ?? "fs,http",
        outDir: outDir ?? outRoot,
        llm: llmPolicy,
        restartFromPhase: phase,
        restartFromRunId: parentId,
        ...(chromeDevtoolsServer
          ? {
              chromeDevtoolsServer: {
                command: chromeDevtoolsServer.command,
                ...(chromeDevtoolsServer.args
                  ? { args: chromeDevtoolsServer.args }
                  : {}),
                ...(chromeDevtoolsServer.cwd
                  ? { cwd: chromeDevtoolsServer.cwd }
                  : {}),
              },
            }
          : {}),
      } satisfies VerifySpecInput;

      const { result } = await verifySpec(ctx, verifyInput);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "verify_spec",
    {
      description:
        "Run verification against a spec and target, returning a structured VerificationResult. To reuse a prior run’s Spec IR or replan, pass restartFromPhase (spec_ir | llm_plan) with restartFromRunId, or call restart_verify_spec.",
      inputSchema: {
        specMarkdown: z.string().optional(),
        spec: SpecIRSchema.optional(),
        specBundle: SpecBundleSchema.optional(),
        targetUrl: z.string(),
        tools: z.string().optional(),
        outDir: z.string().optional(),
        llm: LlmPolicySchema.optional(),
        chromeDevtoolsServer: z
          .object({
            command: z.string(),
            args: z.array(z.string()).optional(),
            cwd: z.string().optional(),
          })
          .optional(),
        restartFromPhase: z.enum(["start", "spec_ir", "llm_plan"]).optional(),
        restartFromRunId: z.string().optional(),
      },
      outputSchema: VerificationResultSchema,
    },
    async ({
      specMarkdown,
      spec,
      specBundle,
      targetUrl,
      tools,
      outDir,
      llm,
      chromeDevtoolsServer,
      restartFromPhase,
      restartFromRunId,
    }) => {
      const parsedBundle = specBundle
        ? SpecBundleSchema.parse(specBundle)
        : undefined;
      const parsedSpec = specMarkdown
        ? undefined
        : SpecIRSchema.parse(spec ?? {});

      const llmPolicy = LlmPolicySchema.parse(llm ?? { provider: "ollama" });

      const verifyInput = {
        targetUrl,
        tools: tools ?? "fs,http",
        outDir: outDir ?? outRoot,
        llm: llmPolicy,
        ...(specMarkdown ? { specMarkdown } : {}),
        ...(!specMarkdown && parsedSpec ? { spec: parsedSpec } : {}),
        ...(parsedBundle ? { specBundle: parsedBundle } : {}),
        ...(chromeDevtoolsServer
          ? {
              chromeDevtoolsServer: {
                command: chromeDevtoolsServer.command,
                ...(chromeDevtoolsServer.args
                  ? { args: chromeDevtoolsServer.args }
                  : {}),
                ...(chromeDevtoolsServer.cwd
                  ? { cwd: chromeDevtoolsServer.cwd }
                  : {}),
              },
            }
          : {}),
        ...(restartFromPhase && restartFromPhase !== "start"
          ? {
              restartFromPhase: RestartFromPhaseSchema.parse(restartFromPhase),
              ...(restartFromRunId?.trim()
                ? { restartFromRunId: restartFromRunId.trim() }
                : {}),
            }
          : {}),
      } satisfies VerifySpecInput;

      const { result } = await verifySpec(ctx, verifyInput);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "get_report",
    {
      description: "Fetch a stored JSON report by runId.",
      inputSchema: { runId: z.string() },
      outputSchema: z.any(),
    },
    async ({ runId }) => {
      const parsed = getReport(ctx, { runId });
      return {
        content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
        structuredContent: parsed,
      };
    },
  );

  server.registerTool(
    "get_artifact",
    {
      description: "Fetch artifact metadata and content path for a run.",
      inputSchema: { runId: z.string(), artifactId: z.string() },
      outputSchema: z.any(),
    },
    async ({ runId, artifactId }) => {
      const structuredContent = getArtifact(ctx, { runId, artifactId });
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "explain_failure",
    {
      description: "Summarize why a requirement failed/blocked for a run.",
      inputSchema: { runId: z.string(), requirementId: z.string() },
      outputSchema: z.any(),
    },
    async ({ runId, requirementId }) => {
      const structuredContent = explainFailure(ctx, { runId, requirementId });
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  // Extra helpers for the dashboard: fetch full run graph.
  server.registerTool(
    "get_run_graph",
    {
      description:
        "Fetch run details: requirements, probes, tool calls, artifacts.",
      inputSchema: { runId: z.string() },
      outputSchema: z.any(),
    },
    async ({ runId }) => {
      const structuredContent = getRunGraph(ctx, { runId });
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ],
        structuredContent,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Spec-driven verifier MCP server running on stdio.");
}
