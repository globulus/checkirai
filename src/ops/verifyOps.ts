import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { ArtifactStore } from "../artifacts/store.js";
import { buildCapabilityGraph } from "../capabilities/registry.js";
import {
  synthesizeMarkdownSummary,
  synthesizeResult,
} from "../core/synthesize.js";
import { judgeDeterministic } from "../evaluators/judge.js";
import { judgeLlmSecondPass } from "../evaluators/llmJudge.js";
import { judgeWithSelfConsistency } from "../evaluators/llmJudgePrimary.js";
import { executePlan } from "../executors/engine.js";
import type { ExecutorIntegrations } from "../executors/integrations.js";
import { executeToolCallPlan } from "../executors/planExecutor.js";
import { createFsIntegration } from "../integrations/fs/fsIntegration.js";
import { createHttpIntegration } from "../integrations/http/httpIntegration.js";
import { createShellIntegration } from "../integrations/shell/shellIntegration.js";
import { checkOllamaRunning } from "../llm/modelOps.js";
import { type LlmPolicy, LlmPolicySchema } from "../llm/types.js";
import type { McpServerConfig } from "../mcp/types.js";
import {
  findLatestLlmOutputByKind,
  insertArtifact,
} from "../persistence/repo/artifactRepo.js";
import { insertProbes } from "../persistence/repo/probeRepo.js";
import {
  insertRequirements,
  updateRequirementResult,
} from "../persistence/repo/requirementRepo.js";
import {
  getRun,
  insertRunIfMissing,
  updateRunLineage,
  updateRunStatus,
} from "../persistence/repo/runRepo.js";
import { insertToolCalls } from "../persistence/repo/toolCallRepo.js";
import { planWithSelfConsistency } from "../planners/llmPlanner.js";
import { planStepsWithLlm } from "../planners/llmStepPlanner.js";
import {
  requiredPolicyForCapabilities,
  type TestPlanIR,
  TestPlanIRSchema,
  validatePlan,
} from "../planners/planIr.js";
import { planProbes } from "../planners/planner.js";
import type { PolicyName } from "../policies/policy.js";
import { VerifierError } from "../shared/errors.js";
import type { SpecBundle } from "../spec/bundle.js";
import { resolveSpecBundle } from "../spec/contextResolution.js";
import { type SpecIR, SpecIRSchema } from "../spec/ir.js";
import { normalizeMarkdownToSpecIRWithLlmDetailed } from "../spec/normalize.js";
import { ollamaStopModel } from "../llm/ollamaCli.js";
import type { OpsContext } from "./context.js";
import type { RunEvent, RunEventSink } from "./events.js";

function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

export const RestartFromPhaseSchema = z.enum(["start", "spec_ir", "llm_plan"]);
export type RestartFromPhase = z.infer<typeof RestartFromPhaseSchema>;

const ARTIFACT_KIND_SPEC_IR = "spec_ir";
const ARTIFACT_KIND_TEST_PLAN_IR = "test_plan_ir";

function persistLlmOutputJsonArtifact(opts: {
  db: OpsContext["db"];
  artifactsDir: string;
  runId: string;
  value: unknown;
  metadata: Record<string, unknown>;
}) {
  const store = new ArtifactStore({
    rootDir: opts.artifactsDir,
    runId: opts.runId,
  });
  const ref = store.writeJson("llm_output", opts.value, {
    metadata: opts.metadata,
  });
  insertArtifact(opts.db, {
    id: ref.id,
    run_id: opts.runId,
    type: ref.type,
    path: join(opts.artifactsDir, ref.path),
    sha256: ref.sha256,
    created_at: ref.createdAt,
    metadata_json: ref.metadata ? JSON.stringify(ref.metadata) : null,
  });
}

export type VerifySpecInput = {
  specMarkdown?: string;
  spec?: SpecIR;
  specBundle?: SpecBundle;
  targetUrl: string;
  tools?: string; // comma-separated
  policyName?: PolicyName;
  llm?: LlmPolicy;
  outDir?: string;
  chromeDevtoolsServer?: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  /** When not `start`, `restartFromRunId` must point to a completed parent run with saved artifacts. */
  restartFromPhase?: RestartFromPhase;
  restartFromRunId?: string;
};

export async function verifySpec(
  ctx: OpsContext,
  input: VerifySpecInput,
  opts?: { onEvent?: RunEventSink; runId?: string },
) {
  const outRoot = input.outDir ?? ctx.outRoot;
  const runsDir = join(outRoot, "runs");
  const artifactsDir = join(outRoot, "artifacts");
  ensureDir(runsDir);
  ensureDir(artifactsDir);

  const llmPolicy = LlmPolicySchema.parse(input.llm ?? { provider: "ollama" });
  const requestedPolicy: PolicyName = input.policyName ?? "read_only";

  const restartFromPhase = RestartFromPhaseSchema.parse(
    input.restartFromPhase ?? "start",
  );
  const parentRunId =
    typeof input.restartFromRunId === "string" && input.restartFromRunId.trim()
      ? input.restartFromRunId.trim()
      : undefined;

  if (restartFromPhase !== "start" && !parentRunId) {
    throw new Error(
      `restartFromPhase=${restartFromPhase} requires restartFromRunId (parent run id).`,
    );
  }
  if (restartFromPhase !== "start" && parentRunId) {
    const parent = getRun(ctx.db, parentRunId);
    if (!parent) throw new Error(`Unknown parent runId: ${parentRunId}`);
  }

  const runId = opts?.runId ?? randomUUID();
  const createdAt = nowIso();
  const start = performance.now();

  const lineageParent: string | null =
    restartFromPhase !== "start" && parentRunId ? parentRunId : null;
  const lineagePhase: RestartFromPhase | null =
    restartFromPhase !== "start" ? restartFromPhase : null;

  // Insert the run row immediately so the dashboard can fetch it even if
  // spec normalization (LLM) takes time.
  insertRunIfMissing(ctx.db, {
    id: runId,
    created_at: createdAt,
    target_base_url: input.targetUrl,
    policy_name: null,
    llm_provider: llmPolicy.provider,
    llm_model: llmPolicy.provider === "ollama" ? llmPolicy.ollamaModel : null,
    status: "running",
    confidence: null,
    summary_md_path: null,
    report_json_path: null,
    parent_run_id: lineageParent,
    restart_from_phase: lineagePhase,
  });
  if (lineageParent) {
    updateRunLineage(ctx.db, runId, {
      parent_run_id: lineageParent,
      restart_from_phase: lineagePhase,
    });
  }

  const publish = (e: RunEvent) => {
    ctx.events.publish(e);
    opts?.onEvent?.(e);
  };

  const ollamaModelsUsed = new Set<string>();
  const recordModel = (m: string) => {
    if (typeof m === "string" && m.trim()) ollamaModelsUsed.add(m.trim());
  };

  try {
    // Resolve spec
    let specIr: SpecIR | undefined;

    if (
      (restartFromPhase === "spec_ir" || restartFromPhase === "llm_plan") &&
      parentRunId
    ) {
      const row = findLatestLlmOutputByKind(
        ctx.db,
        parentRunId,
        ARTIFACT_KIND_SPEC_IR,
      );
      if (!row) {
        throw new Error(
          `cannot restart from ${restartFromPhase}: parent run ${parentRunId} has no saved spec_ir artifact (re-run verification from start on that spec first).`,
        );
      }
      const raw = readFileSync(row.path, "utf8");
      specIr = SpecIRSchema.parse(JSON.parse(raw) as unknown);
    } else if (input.specMarkdown) {
      const toolCallId = randomUUID();
      const startedAtIso = nowIso();
      publish({
        type: "step_started",
        runId,
        toolCallId,
        capability: "spec_normalization",
        action: "normalize_markdown",
        startedAt: startedAtIso,
        args: { llm: llmPolicy, specChars: input.specMarkdown.length },
      });
      const out = await normalizeMarkdownToSpecIRWithLlmDetailed(
        input.specMarkdown,
        llmPolicy,
        {
          onLlmCall: (e) => {
            recordModel(e.model);
            publish({
              type: "llm_call",
              runId,
              startedAt: startedAtIso,
              endedAt: nowIso(),
              phase: e.phase,
              provider: e.provider,
              host: e.host,
              model: e.model,
              durationMs: e.durationMs,
              promptChars: e.promptChars,
              responseChars: e.responseChars,
              truncated: e.truncated,
              ...(e.system ? { system: e.system } : {}),
              prompt: e.prompt,
              responseText: e.responseText,
            });
          },
        },
      );
      specIr = out.specIr;
      publish({
        type: "step_finished",
        runId,
        toolCallId,
        capability: "spec_normalization",
        action: "normalize_markdown",
        startedAt: startedAtIso,
        endedAt: nowIso(),
        ok: true,
        result: out.meta,
      });
    } else if (input.spec) {
      specIr = input.spec;
    }

    if (input.specBundle) {
      const resolved = await resolveSpecBundle(input.specBundle, {
        http: createHttpIntegration(),
        fs: createFsIntegration(),
      });
      const toolCallId = randomUUID();
      const startedAtIso = nowIso();
      publish({
        type: "step_started",
        runId,
        toolCallId,
        capability: "spec_normalization",
        action: "normalize_bundle",
        startedAt: startedAtIso,
        args: { llm: llmPolicy, specChars: resolved.combinedMarkdown.length },
      });
      const out = await normalizeMarkdownToSpecIRWithLlmDetailed(
        resolved.combinedMarkdown,
        llmPolicy,
        {
          onLlmCall: (e) => {
            recordModel(e.model);
            publish({
              type: "llm_call",
              runId,
              startedAt: startedAtIso,
              endedAt: nowIso(),
              phase: e.phase,
              provider: e.provider,
              host: e.host,
              model: e.model,
              durationMs: e.durationMs,
              promptChars: e.promptChars,
              responseChars: e.responseChars,
              truncated: e.truncated,
              ...(e.system ? { system: e.system } : {}),
              prompt: e.prompt,
              responseText: e.responseText,
            });
          },
        },
      );
      specIr = out.specIr;
      publish({
        type: "step_finished",
        runId,
        toolCallId,
        capability: "spec_normalization",
        action: "normalize_bundle",
        startedAt: startedAtIso,
        endedAt: nowIso(),
        ok: true,
        result: out.meta,
      });
    }

    if (!specIr)
      throw new Error("Missing spec input (specMarkdown|spec|specBundle).");

    // Persist normalized SpecIR for future restarts (and copy on restart runs).
    persistLlmOutputJsonArtifact({
      db: ctx.db,
      artifactsDir,
      runId,
      value: specIr,
      metadata: { phase: "spec_normalization", kind: ARTIFACT_KIND_SPEC_IR },
    });

    // Tell the dashboard we're continuing even if a preflight step hangs/fails.
    publish({
      type: "run_started",
      runId,
      createdAt,
      meta: {
        targetUrl: input.targetUrl,
        specIr,
        ...(lineageParent
          ? { parentRunId: lineageParent, restartFromPhase }
          : {}),
      },
    });

    if (llmPolicy.provider === "ollama") {
      const toolCallId = randomUUID();
      const startedAtIso = nowIso();
      publish({
        type: "step_started",
        runId,
        toolCallId,
        capability: "preflight",
        action: "check_ollama",
        startedAt: startedAtIso,
        args: { host: llmPolicy.ollamaHost, model: llmPolicy.ollamaModel },
      });
      const status = await checkOllamaRunning(llmPolicy.ollamaHost);
      publish({
        type: "step_finished",
        runId,
        toolCallId,
        capability: "preflight",
        action: "check_ollama",
        startedAt: startedAtIso,
        endedAt: nowIso(),
        ok: status.ok,
        result: status,
        ...(status.ok
          ? {}
          : { errorMessage: status.error?.message ?? "Ollama not running" }),
      });
      if (!status.ok)
        throw new Error(status.error?.message ?? "Ollama not running");
    }

    // Capabilities/integrations
    const toolSet = new Set(
      String(input.tools ?? "fs,http")
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

    const integrations: Record<string, unknown> = {};
    if (toolSet.has("fs")) integrations.fs = createFsIntegration();
    if (toolSet.has("http")) integrations.http = createHttpIntegration();
    if (toolSet.has("shell"))
      integrations.shell = createShellIntegration({ allowCommands: [] });

    // Preflight: ensure target is reachable before we spawn browser tools.
    if (toolSet.has("http")) {
      const http = integrations.http as ReturnType<
        typeof createHttpIntegration
      >;
      const toolCallId = randomUUID();
      const startedAtIso = nowIso();
      publish({
        type: "step_started",
        runId,
        toolCallId,
        capability: "preflight",
        action: "check_target_url",
        startedAt: startedAtIso,
        args: { url: input.targetUrl },
      });
      try {
        const res = await http.get(input.targetUrl, {
          // Avoid downloading huge bodies; just see if the server responds.
          headers: { range: "bytes=0-200" },
        });
        if (res.status >= 500) {
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            `Target URL responded with ${res.status}: ${input.targetUrl}`,
            { details: { status: res.status } },
          );
        }
        publish({
          type: "step_finished",
          runId,
          toolCallId,
          capability: "preflight",
          action: "check_target_url",
          startedAt: startedAtIso,
          endedAt: nowIso(),
          ok: true,
          result: { status: res.status },
        });
      } catch (e) {
        publish({
          type: "step_finished",
          runId,
          toolCallId,
          capability: "preflight",
          action: "check_target_url",
          startedAt: startedAtIso,
          endedAt: nowIso(),
          ok: false,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Target URL is not reachable: ${input.targetUrl}`,
          { cause: e },
        );
      }
    }

    if (toolSet.has("chrome-devtools")) {
      const toolCallId = randomUUID();
      const startedAtIso = nowIso();
      publish({
        type: "step_started",
        runId,
        toolCallId,
        capability: "preflight",
        action: "init_chrome_devtools",
        startedAt: startedAtIso,
        args: { command: input.chromeDevtoolsServer?.command ?? null },
      });
      if (!input.chromeDevtoolsServer?.command) {
        publish({
          type: "step_finished",
          runId,
          toolCallId,
          capability: "preflight",
          action: "init_chrome_devtools",
          startedAt: startedAtIso,
          endedAt: nowIso(),
          ok: false,
          errorMessage:
            "chrome-devtools requested but chromeDevtoolsServer config missing (command/args/cwd).",
        });
        throw new Error(
          "chrome-devtools requested but chromeDevtoolsServer config missing (command/args/cwd).",
        );
      }
      const mod = await import(
        "../integrations/chromeDevtools/chromeDevtoolsMcpIntegration.js"
      );
      const serverCfg: McpServerConfig = {
        kind: "stdio",
        command: input.chromeDevtoolsServer.command,
      };
      if (input.chromeDevtoolsServer.args) {
        // Avoid profile collisions by default. Users can still override by explicitly
        // passing their own args including a different userDataDir.
        const args = input.chromeDevtoolsServer.args.slice();
        if (!args.includes("--isolated")) args.push("--isolated");
        serverCfg.args = args;
      }
      if (input.chromeDevtoolsServer.cwd)
        serverCfg.cwd = input.chromeDevtoolsServer.cwd;
      if (input.chromeDevtoolsServer.env)
        serverCfg.env = input.chromeDevtoolsServer.env;
      integrations.chrome = new mod.ChromeDevtoolsMcpIntegration({
        server: serverCfg,
      });
      publish({
        type: "step_finished",
        runId,
        toolCallId,
        capability: "preflight",
        action: "init_chrome_devtools",
        startedAt: startedAtIso,
        endedAt: nowIso(),
        ok: true,
      });
    }

    // Default path: generic LLM plan→execute→judge loop.
    // Fallback: legacy probe-based flow if planner/executor/judge fails.
    const chrome = (integrations as ExecutorIntegrations).chrome;
    const canUseGenericLlmLoop =
      llmPolicy.provider !== "none" && Boolean(chrome);

    if (restartFromPhase === "llm_plan" && !canUseGenericLlmLoop) {
      throw new Error(
        "restart from llm_plan requires chrome-devtools in tools and an LLM provider other than none (same conditions as the generic plan→execute path).",
      );
    }

    const runLegacyProbeFlow = async () => {
      // LLM step planning (proceduralization) for legacy probes
      if (
        llmPolicy.provider !== "none" &&
        (integrations as ExecutorIntegrations).chrome
      ) {
        try {
          const chromeTools = await (
            integrations as ExecutorIntegrations
          ).chrome!.listTools();
          const planned = await planStepsWithLlm({
            spec: specIr!,
            llm: llmPolicy,
            targetUrl: input.targetUrl,
            chromeTools,
          });
          specIr = planned.spec;
        } catch {
          // Best-effort: if planning fails, continue with non-procedural probes.
        }
      }

      const plan = planProbes(specIr!, capGraph.capabilities);
      const planNeedsInteract = plan.sessions.some((s) =>
        s.probes.some((p) => p.capabilityNeeds.includes("interact")),
      );
      const effectivePolicy: PolicyName =
        requestedPolicy === "read_only" && planNeedsInteract
          ? "ui_only"
          : requestedPolicy;

      insertProbes(
        ctx.db,
        plan.sessions.flatMap((s) =>
          s.probes.map((p) => ({
            id: p.id,
            run_id: runId,
            requirement_id: p.requirementId,
            strategy: p.strategy ?? null,
            side_effects: p.sideEffects ?? null,
            cost_hint: p.costHint ?? null,
          })),
        ),
      );

      const artifactStore = new ArtifactStore({ rootDir: artifactsDir, runId });
      const execOut = await executePlan({
        runId,
        plan,
        capabilities: capGraph.capabilities,
        integrations: integrations as ExecutorIntegrations,
        artifactStore,
        policyName: effectivePolicy,
        targetUrl: input.targetUrl,
        onEvent: (e) => {
          ctx.events.publish(e);
          opts?.onEvent?.(e);
        },
      });

      // Legacy judgment: deterministic + LLM second pass.
      let requirementResults = judgeDeterministic({
        spec: specIr!,
        plan,
        toolCalls: execOut.toolCalls,
        artifacts: execOut.artifacts,
        artifactRootDir: artifactsDir,
      });

      let llmSecondPassMeta:
        | { attempted: number; applied: number }
        | { attempted: number; applied: number; error: string }
        | undefined;
      if (llmPolicy.provider !== "none") {
        const inconclusiveIds = requirementResults
          .filter((r) => r.verdict === "inconclusive")
          .map((r) => r.requirement_id);
        if (inconclusiveIds.length) {
          try {
            const before = new Map(
              requirementResults.map(
                (r) => [r.requirement_id, r.verdict] as const,
              ),
            );
            const out = await judgeLlmSecondPass(
              {
                spec: specIr!,
                plan,
                toolCalls: execOut.toolCalls,
                artifacts: execOut.artifacts,
                artifactRootDir: artifactsDir,
                llm: llmPolicy,
                requirementIds: inconclusiveIds,
              },
              requirementResults,
              { onSelectedModel: recordModel },
            );
            requirementResults = out.results;
            const applied = requirementResults.filter((r) => {
              const prev = before.get(r.requirement_id);
              return (
                prev === "inconclusive" && r.judgment_mode === "model_assisted"
              );
            }).length;
            llmSecondPassMeta = { attempted: inconclusiveIds.length, applied };
          } catch (e) {
            llmSecondPassMeta = {
              attempted: inconclusiveIds.length,
              applied: 0,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }
      }

      return {
        execOut,
        requirementResults,
        meta: { llm_second_pass: llmSecondPassMeta },
      };
    };

    // Planning + persistence setup
    let execOut:
      | { toolCalls: any[]; artifacts: any[] } // legacy/plan share shape
      | undefined;
    let requirementResults: any[] | undefined;
    let metaExtra: Record<string, unknown> = {};

    insertRequirements(
      ctx.db,
      specIr.requirements.map((r) => ({
        run_id: runId,
        id: r.id,
        source_text: r.source_text,
        type: r.type,
        priority: r.priority,
      })),
    );

    try {
      if (canUseGenericLlmLoop && chrome) {
        const toolCallId = randomUUID();
        const startedAtIso = nowIso();
        publish({
          type: "step_started",
          runId,
          toolCallId,
          capability: "planning",
          action: "chrome_list_tools",
          startedAt: startedAtIso,
        });
        let chromeTools: Awaited<ReturnType<typeof chrome.listTools>>;
        try {
          chromeTools = await chrome.listTools();
          publish({
            type: "step_finished",
            runId,
            toolCallId,
            capability: "planning",
            action: "chrome_list_tools",
            startedAt: startedAtIso,
            endedAt: nowIso(),
            ok: true,
            result: { toolCount: chromeTools.length },
          });
        } catch (e) {
          publish({
            type: "step_finished",
            runId,
            toolCallId,
            capability: "planning",
            action: "chrome_list_tools",
            startedAt: startedAtIso,
            endedAt: nowIso(),
            ok: false,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }

        const toolCallId2 = randomUUID();
        const startedAtIso2 = nowIso();
        let planned: { plan: TestPlanIR; meta: Record<string, unknown> };

        if (restartFromPhase === "llm_plan") {
          const toolDescriptors = chromeTools.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.inputSchema !== undefined
              ? { inputSchema: t.inputSchema }
              : {}),
          }));
          publish({
            type: "step_started",
            runId,
            toolCallId: toolCallId2,
            capability: "planning",
            action: "llm_plan_with_self_consistency",
            startedAt: startedAtIso2,
            args: { reusedFromRunId: parentRunId, skippedLlm: true },
          });
          if (!parentRunId) {
            throw new Error("restart from llm_plan requires restartFromRunId");
          }
          const planRow = findLatestLlmOutputByKind(
            ctx.db,
            parentRunId,
            ARTIFACT_KIND_TEST_PLAN_IR,
          );
          if (!planRow) {
            publish({
              type: "step_finished",
              runId,
              toolCallId: toolCallId2,
              capability: "planning",
              action: "llm_plan_with_self_consistency",
              startedAt: startedAtIso2,
              endedAt: nowIso(),
              ok: false,
              errorMessage: `cannot restart from llm_plan: parent run ${parentRunId} has no saved test_plan_ir artifact.`,
            });
            throw new Error(
              `cannot restart from llm_plan: parent run ${parentRunId} has no saved test_plan_ir artifact.`,
            );
          }
          const planJson = readFileSync(planRow.path, "utf8");
          const parsedPlan = TestPlanIRSchema.parse(
            JSON.parse(planJson) as unknown,
          );
          const validation = validatePlan(parsedPlan, toolDescriptors);
          if (!validation.ok) {
            const msg = `Cached plan from parent run ${parentRunId} is incompatible with current MCP tool surface: ${validation.issues
              .slice(0, 5)
              .map((i) => i.message)
              .join("; ")}`;
            publish({
              type: "step_finished",
              runId,
              toolCallId: toolCallId2,
              capability: "planning",
              action: "llm_plan_with_self_consistency",
              startedAt: startedAtIso2,
              endedAt: nowIso(),
              ok: false,
              errorMessage: msg,
            });
            throw new Error(msg);
          }
          planned = {
            plan: parsedPlan,
            meta: {
              resumedFromRunId: parentRunId,
              skippedLlm: true,
              validationScore: validation.score,
            },
          };
          persistLlmOutputJsonArtifact({
            db: ctx.db,
            artifactsDir,
            runId,
            value: planned.plan,
            metadata: {
              phase: "planning",
              kind: ARTIFACT_KIND_TEST_PLAN_IR,
              copiedFromRunId: parentRunId,
            },
          });
          publish({
            type: "step_finished",
            runId,
            toolCallId: toolCallId2,
            capability: "planning",
            action: "llm_plan_with_self_consistency",
            startedAt: startedAtIso2,
            endedAt: nowIso(),
            ok: true,
            result: planned.meta,
          });
        } else {
          publish({
            type: "step_started",
            runId,
            toolCallId: toolCallId2,
            capability: "planning",
            action: "llm_plan_with_self_consistency",
            startedAt: startedAtIso2,
            args: { attempts: 5, llm: llmPolicy },
          });
          try {
            const out = await planWithSelfConsistency({
              llm: llmPolicy,
              spec: specIr,
              targetUrl: input.targetUrl,
              tools: chromeTools,
              attempts: 5,
              onSelectedModel: recordModel,
            });
            planned = {
              plan: out.plan,
              meta: out.meta as Record<string, unknown>,
            };
            persistLlmOutputJsonArtifact({
              db: ctx.db,
              artifactsDir,
              runId,
              value: planned.plan,
              metadata: { phase: "planning", kind: ARTIFACT_KIND_TEST_PLAN_IR },
            });
            publish({
              type: "step_finished",
              runId,
              toolCallId: toolCallId2,
              capability: "planning",
              action: "llm_plan_with_self_consistency",
              startedAt: startedAtIso2,
              endedAt: nowIso(),
              ok: true,
              result: planned.meta,
            });
          } catch (e) {
            publish({
              type: "step_finished",
              runId,
              toolCallId: toolCallId2,
              capability: "planning",
              action: "llm_plan_with_self_consistency",
              startedAt: startedAtIso2,
              endedAt: nowIso(),
              ok: false,
              errorMessage: e instanceof Error ? e.message : String(e),
            });
            throw e;
          }
        }

        // Safety net: if the model returns an empty plan, we still need baseline evidence
        // (at minimum a snapshot) so requirements like `text_present` can be judged.
        if (!planned.plan.toolCalls.length) {
          planned.plan.toolCalls = [
            {
              capability: "navigate",
              tool: "navigate_page",
              args: { url: input.targetUrl },
            },
            {
              capability: "read_ui_structure",
              tool: "take_snapshot",
              args: {},
            },
            {
              capability: "read_visual",
              tool: "take_screenshot",
              args: {},
              label: "dashboard",
            },
            {
              capability: "interact",
              tool: "evaluate_script",
              args: {
                function: `() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  return buttons.map((b) => {
    const cs = getComputedStyle(b);
    const text = (b.innerText || b.textContent || "").trim();
    return {
      text,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
    };
  });
}`,
              },
              label: "button_styles",
            },
          ];
        }

        const caps = new Set(planned.plan.toolCalls.map((c) => c.capability));
        const effectivePolicy: PolicyName =
          requestedPolicy === "read_only" &&
          requiredPolicyForCapabilities(caps) === "ui_only"
            ? "ui_only"
            : requestedPolicy;

        metaExtra.llm_planner = planned.meta;

        const artifactStore = new ArtifactStore({
          rootDir: artifactsDir,
          runId,
        });
        execOut = await executeToolCallPlan({
          runId,
          toolCalls: planned.plan.toolCalls,
          capabilities: capGraph.capabilities,
          integrations: integrations as ExecutorIntegrations,
          artifactStore,
          policyName: effectivePolicy,
          onEvent: (e) => {
            ctx.events.publish(e);
            opts?.onEvent?.(e);
          },
        });

        const judged = await judgeWithSelfConsistency({
          llm: llmPolicy,
          spec: specIr,
          plan: planned.plan,
          toolCalls: execOut.toolCalls,
          artifacts: execOut.artifacts,
          artifactRootDir: artifactsDir,
          attempts: 3,
          onSelectedModel: recordModel,
        });
        requirementResults = judged.results;
        metaExtra.llm_judge = judged.meta;
      } else {
        const legacy = await runLegacyProbeFlow();
        execOut = legacy.execOut;
        requirementResults = legacy.requirementResults;
        metaExtra = { ...metaExtra, ...legacy.meta };
      }
    } finally {
      // Ensure we don't leave stdio MCP server processes running after the run finishes.
      // (This is especially important for the CLI, otherwise Node won't exit.)
      const chrome = (integrations as ExecutorIntegrations).chrome;
      if (chrome) {
        try {
          await chrome.close();
        } catch {
          // ignore best-effort cleanup
        }
      }
    }

    // Persist artifacts + tool calls
    if (!execOut || !requirementResults) {
      throw new Error("Internal error: missing execution/judgment outputs.");
    }
    for (const a of execOut.artifacts) {
      insertArtifact(ctx.db, {
        id: a.id,
        run_id: runId,
        type: a.type,
        path: join(artifactsDir, a.path),
        sha256: a.sha256,
        created_at: a.createdAt,
        metadata_json: a.metadata ? JSON.stringify(a.metadata) : null,
      });
    }

    insertToolCalls(
      ctx.db,
      execOut.toolCalls.map((t) => ({
        id: t.id,
        run_id: runId,
        probe_id: t.probeId ?? null,
        capability: t.capability,
        action: t.action,
        started_at: t.startedAt,
        ended_at: t.endedAt,
        ok: t.ok ? 1 : 0,
        error_code: t.errorCode ?? null,
        error_message: t.errorMessage ?? null,
        output_artifact_id: t.outputArtifactId ?? null,
      })),
    );

    for (const rr of requirementResults) {
      updateRequirementResult(ctx.db, runId, rr.requirement_id, {
        verdict: rr.verdict,
        confidence: rr.confidence,
        judgment_mode: rr.judgment_mode,
        why_failed_or_blocked: rr.why_failed_or_blocked ?? null,
        repair_hint: rr.repair_hint ?? null,
      });
    }

    const durationMs = Math.round(performance.now() - start);
    const result = synthesizeResult({
      requirementResults,
      artifacts: execOut.artifacts,
      toolCalls: execOut.toolCalls.length,
      sessions: 1,
      durationMs,
      blockedReasons: requirementResults
        .filter((r) => r.verdict === "blocked" && r.why_failed_or_blocked)
        .map((r) => r.why_failed_or_blocked as string),
      meta: {
        runId,
        targetBaseUrl: input.targetUrl,
        ...metaExtra,
      },
    });

    // Write report + summary
    const runDir = join(runsDir, runId);
    ensureDir(runDir);
    const reportPath = join(runDir, "report.json");
    const summaryPath = join(runDir, "summary.md");
    writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf8");
    writeFileSync(summaryPath, synthesizeMarkdownSummary(result), "utf8");

    updateRunStatus(ctx.db, runId, result.overall_status, result.confidence);

    // Best-effort: store paths
    const stmt = ctx.db.prepare(`
    UPDATE runs
    SET summary_md_path = @summary_md_path,
        report_json_path = @report_json_path
    WHERE id = @id
  `);
    stmt.run({
      id: runId,
      summary_md_path: summaryPath,
      report_json_path: reportPath,
    });

    const endedAt = nowIso();
    ctx.events.publish({
      type: "run_finished",
      runId,
      endedAt,
      status: result.overall_status,
      confidence: result.confidence,
    });
    opts?.onEvent?.({
      type: "run_finished",
      runId,
      endedAt,
      status: result.overall_status,
      confidence: result.confidence,
    });

    return { runId, result };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const code =
      e &&
      typeof e === "object" &&
      "code" in e &&
      typeof (e as any).code === "string"
        ? (e as any).code
        : undefined;
    const details =
      e && typeof e === "object" && "details" in e
        ? (e as any).details
        : undefined;

    updateRunStatus(ctx.db, runId, "error");
    publish({
      type: "run_error",
      runId,
      ts: nowIso(),
      message,
      ...(code ? { code } : {}),
      ...(details !== undefined ? { details } : {}),
    });
    publish({
      type: "run_finished",
      runId,
      endedAt: nowIso(),
      status: "error",
    });
    throw e;
  } finally {
    // Best-effort: unload any Ollama models used during this run to free RAM.
    // Do NOT kill the Ollama daemon; just ask it to stop the model(s).
    if (llmPolicy.provider === "ollama" && ollamaModelsUsed.size > 0) {
      await Promise.all(
        [...ollamaModelsUsed].map((model) =>
          ollamaStopModel({ host: llmPolicy.ollamaHost, model }).catch(() => ({
            ok: false,
          })),
        ),
      );
    }
  }
}
