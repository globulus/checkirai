import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { pruneArtifactRuns } from "../artifacts/prune.js";
import { ArtifactStore } from "../artifacts/store.js";
import { buildCapabilityGraph } from "../capabilities/registry.js";
import {
  loadProjectConfig,
  mergeLlmPolicyWithProjectProfile,
} from "../config/projectConfig.js";
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
import { ollamaStopModel } from "../llm/ollamaCli.js";
import { runTriageMarkdown } from "../evaluators/triageRun.js";
import {
  ollamaModelsFromPolicy,
  policyJudgeOrPlannerActive,
  policyUsesOllama,
  summarizeLlmPolicyForRun,
  type LlmPolicy,
  LlmPolicySchema,
} from "../llm/types.js";
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
  DEFAULT_BUTTON_STYLE_TOOL_CALL,
  mergeButtonStyleEvidenceIfNeeded,
} from "../planners/buttonStyleEvidence.js";
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
  maxRunMs?: number;
  runCommandAllowlist?: string[];
  stepRetries?: number;
  stepRetryDelayMs?: number;
  isolateProbeSessions?: boolean;
  artifactMaxRuns?: number;
  /** When set, run via shell before probes (requires `http` in tools to poll readiness). */
  launchCommand?: string;
  launchCwd?: string;
  /** Max wait for `targetUrl` to respond after spawn (default 30s). */
  launchReadyTimeoutMs?: number;
  selfTestTargetBaseUrl?: string;
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

  const projectCfg = loadProjectConfig().config;
  const def = projectCfg?.defaults;
  const maxRunMs = input.maxRunMs ?? def?.maxRunMs;
  const runCommandAllowlist =
    input.runCommandAllowlist ?? def?.runCommandAllowlist;
  const stepRetries = input.stepRetries ?? def?.stepRetries;
  const stepRetryDelayMs = input.stepRetryDelayMs ?? def?.stepRetryDelayMs;
  const isolateProbeSessions =
    input.isolateProbeSessions ?? def?.isolateProbeSessions;
  const artifactMaxRuns = input.artifactMaxRuns ?? def?.artifactMaxRuns;
  const allowShellMetacharacters = def?.allowShellMetacharacters === true;
  if (typeof artifactMaxRuns === "number" && artifactMaxRuns > 0) {
    pruneArtifactRuns(artifactsDir, artifactMaxRuns);
  }

  const llmPolicy = mergeLlmPolicyWithProjectProfile(
    LlmPolicySchema.parse(input.llm ?? projectCfg?.llm ?? {}),
    projectCfg ?? undefined,
  );
  const llmRunRow = summarizeLlmPolicyForRun(llmPolicy);
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
    llm_provider: llmRunRow.llm_provider,
    llm_model: llmRunRow.llm_model,
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

  let launchChild: ChildProcess | undefined;

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
              host: e.host ?? "",
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
              host: e.host ?? "",
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

    if (policyUsesOllama(llmPolicy)) {
      const toolCallId = randomUUID();
      const startedAtIso = nowIso();
      publish({
        type: "step_started",
        runId,
        toolCallId,
        capability: "preflight",
        action: "check_ollama",
        startedAt: startedAtIso,
        args: {
          host: llmPolicy.ollamaHost,
          models: ollamaModelsFromPolicy(llmPolicy),
        },
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

    // Preflight: optional launchCommand, then ensure target is reachable.
    if (toolSet.has("http")) {
      const http = integrations.http as ReturnType<
        typeof createHttpIntegration
      >;
      if (input.launchCommand?.trim()) {
        launchChild = spawn(input.launchCommand.trim(), {
          shell: true,
          cwd: input.launchCwd?.trim() || undefined,
          stdio: "ignore",
        });
      }

      const toolCallId = randomUUID();
      const startedAtIso = nowIso();
      publish({
        type: "step_started",
        runId,
        toolCallId,
        capability: "preflight",
        action: "check_target_url",
        startedAt: startedAtIso,
        args: {
          url: input.targetUrl,
          ...(input.launchCommand?.trim()
            ? { launchCommand: input.launchCommand.trim() }
            : {}),
        },
      });
      try {
        const maxWaitMs = input.launchCommand?.trim()
          ? (input.launchReadyTimeoutMs ?? 30_000)
          : 15_000;
        const deadline = Date.now() + maxWaitMs;
        let res: Awaited<ReturnType<typeof http.get>> | undefined;
        while (Date.now() < deadline) {
          try {
            const attempt = await http.get(input.targetUrl, {
              headers: { range: "bytes=0-200" },
            });
            if (attempt.status < 500) {
              res = attempt;
              break;
            }
          } catch {
            // keep polling when launchCommand is warming up
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        if (!res) {
          throw new VerifierError(
            "TOOL_UNAVAILABLE",
            `Target URL did not become reachable within ${maxWaitMs}ms: ${input.targetUrl}`,
          );
        }
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
        if (launchChild && !launchChild.killed) {
          try {
            launchChild.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
        throw new VerifierError(
          "TOOL_UNAVAILABLE",
          `Target URL is not reachable: ${input.targetUrl}`,
          { cause: e },
        );
      }
    } else if (input.launchCommand?.trim()) {
      throw new Error(
        "launchCommand is set but tools do not include 'http' (needed to poll target readiness).",
      );
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
      policyJudgeOrPlannerActive(llmPolicy) && Boolean(chrome);

    if (restartFromPhase === "llm_plan" && !canUseGenericLlmLoop) {
      throw new Error(
        "restart from llm_plan requires chrome-devtools in tools and an LLM provider other than none (same conditions as the generic plan→execute path).",
      );
    }

    const runLegacyProbeFlow = async () => {
      const ac = new AbortController();
      const timer =
        typeof maxRunMs === "number" && maxRunMs > 0
          ? setTimeout(() => ac.abort(), maxRunMs)
          : undefined;
      try {
        // LLM step planning (proceduralization) for legacy probes
        if (
          policyJudgeOrPlannerActive(llmPolicy) &&
          (integrations as ExecutorIntegrations).chrome
        ) {
          const probePlanId = randomUUID();
          const probePlanStarted = nowIso();
          publish({
            type: "step_started",
            runId,
            toolCallId: probePlanId,
            capability: "planning",
            action: "plan_probe_steps",
            startedAt: probePlanStarted,
          });
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
            publish({
              type: "step_finished",
              runId,
              toolCallId: probePlanId,
              capability: "planning",
              action: "plan_probe_steps",
              startedAt: probePlanStarted,
              endedAt: nowIso(),
              ok: true,
              result: { updatedSpec: true },
            });
          } catch {
            // Best-effort: if planning fails, continue with non-procedural probes.
            publish({
              type: "step_finished",
              runId,
              toolCallId: probePlanId,
              capability: "planning",
              action: "plan_probe_steps",
              startedAt: probePlanStarted,
              endedAt: nowIso(),
              ok: true,
              result: { continuedWithoutPlanner: true },
            });
          }
        }

        const plan = planProbes(specIr!, capGraph.capabilities, {
          isolateSessions: isolateProbeSessions === true,
        });
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

        const artifactStore = new ArtifactStore({
          rootDir: artifactsDir,
          runId,
        });
        const execOut = await executePlan({
          runId,
          plan,
          capabilities: capGraph.capabilities,
          integrations: integrations as ExecutorIntegrations,
          artifactStore,
          policyName: effectivePolicy,
          targetUrl: input.targetUrl,
          abortSignal: ac.signal,
          ...(runCommandAllowlist !== undefined ? { runCommandAllowlist } : {}),
          ...(allowShellMetacharacters
            ? { allowShellMetacharacters: true }
            : {}),
          ...(typeof stepRetries === "number" ? { stepRetries } : {}),
          ...(typeof stepRetryDelayMs === "number" ? { stepRetryDelayMs } : {}),
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
          ...(typeof input.selfTestTargetBaseUrl === "string"
            ? { selfTestTargetBaseUrl: input.selfTestTargetBaseUrl }
            : {}),
          targetBaseUrl: input.targetUrl,
        });

        let llmSecondPassMeta:
          | { attempted: number; applied: number }
          | { attempted: number; applied: number; error: string }
          | undefined;
        if (llmPolicy.judge.provider !== "none") {
          const inconclusiveIds = requirementResults
            .filter((r) => r.verdict === "inconclusive")
            .map((r) => r.requirement_id);
          if (inconclusiveIds.length) {
            const secondPassId = randomUUID();
            const secondPassStarted = nowIso();
            publish({
              type: "step_started",
              runId,
              toolCallId: secondPassId,
              capability: "judgment",
              action: "llm_judge_second_pass",
              startedAt: secondPassStarted,
              args: { inconclusiveCount: inconclusiveIds.length },
            });
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
                  prev === "inconclusive" &&
                  r.judgment_mode === "model_assisted"
                );
              }).length;
              llmSecondPassMeta = {
                attempted: inconclusiveIds.length,
                applied,
              };
              publish({
                type: "step_finished",
                runId,
                toolCallId: secondPassId,
                capability: "judgment",
                action: "llm_judge_second_pass",
                startedAt: secondPassStarted,
                endedAt: nowIso(),
                ok: true,
                result: llmSecondPassMeta,
              });
            } catch (e) {
              llmSecondPassMeta = {
                attempted: inconclusiveIds.length,
                applied: 0,
                error: e instanceof Error ? e.message : String(e),
              };
              publish({
                type: "step_finished",
                runId,
                toolCallId: secondPassId,
                capability: "judgment",
                action: "llm_judge_second_pass",
                startedAt: secondPassStarted,
                endedAt: nowIso(),
                ok: false,
                errorMessage:
                  e instanceof Error ? e.message : String(e),
                result: llmSecondPassMeta,
              });
            }
          }
        }

        return {
          execOut,
          requirementResults,
          meta: { llm_second_pass: llmSecondPassMeta },
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
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

        const toolDescriptors = chromeTools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.inputSchema !== undefined
            ? { inputSchema: t.inputSchema }
            : {}),
        }));

        if (restartFromPhase === "llm_plan") {
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
          const mergedPlan = mergeButtonStyleEvidenceIfNeeded(
            specIr,
            parsedPlan,
          );
          const validationMerged = validatePlan(mergedPlan, toolDescriptors);
          if (!validationMerged.ok) {
            const msg = `Cached plan invalid after style-evidence merge: ${validationMerged.issues
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
            plan: mergedPlan,
            meta: {
              resumedFromRunId: parentRunId,
              skippedLlm: true,
              validationScore: validationMerged.score,
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
            const mergedPlan = mergeButtonStyleEvidenceIfNeeded(
              specIr,
              out.plan,
            );
            const validationMerged = validatePlan(mergedPlan, toolDescriptors);
            if (!validationMerged.ok) {
              throw new Error(
                `Plan invalid after style-evidence merge: ${validationMerged.issues
                  .slice(0, 8)
                  .map((i) => i.message)
                  .join("; ")}`,
              );
            }
            planned = {
              plan: mergedPlan,
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
            DEFAULT_BUTTON_STYLE_TOOL_CALL,
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

        const judgeId = randomUUID();
        const judgeStartedAt = nowIso();
        publish({
          type: "step_started",
          runId,
          toolCallId: judgeId,
          capability: "judgment",
          action: "llm_judge_self_consistency",
          startedAt: judgeStartedAt,
          args: {
            requirementCount: specIr.requirements.length,
            attempts: 3,
          },
        });
        let judged: Awaited<ReturnType<typeof judgeWithSelfConsistency>>;
        try {
          judged = await judgeWithSelfConsistency({
            llm: llmPolicy,
            spec: specIr,
            plan: planned.plan,
            toolCalls: execOut.toolCalls,
            artifacts: execOut.artifacts,
            artifactRootDir: artifactsDir,
            attempts: 3,
            onSelectedModel: recordModel,
          });
        } catch (e) {
          publish({
            type: "step_finished",
            runId,
            toolCallId: judgeId,
            capability: "judgment",
            action: "llm_judge_self_consistency",
            startedAt: judgeStartedAt,
            endedAt: nowIso(),
            ok: false,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
        publish({
          type: "step_finished",
          runId,
          toolCallId: judgeId,
          capability: "judgment",
          action: "llm_judge_self_consistency",
          startedAt: judgeStartedAt,
          endedAt: nowIso(),
          ok: true,
          result: judged.meta,
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

    let resultOut = result;
    if (llmPolicy.triage.provider !== "none") {
      const triageId = randomUUID();
      const triageStarted = nowIso();
      publish({
        type: "step_started",
        runId,
        toolCallId: triageId,
        capability: "triage",
        action: "summarize_run",
        startedAt: triageStarted,
      });
      let triageMd: string;
      try {
        triageMd = await runTriageMarkdown({
          policy: llmPolicy,
          result,
          hooks: { onSelectedModel: recordModel },
        });
      } catch (e) {
        publish({
          type: "step_finished",
          runId,
          toolCallId: triageId,
          capability: "triage",
          action: "summarize_run",
          startedAt: triageStarted,
          endedAt: nowIso(),
          ok: false,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
      publish({
        type: "step_finished",
        runId,
        toolCallId: triageId,
        capability: "triage",
        action: "summarize_run",
        startedAt: triageStarted,
        endedAt: nowIso(),
        ok: true,
        result: { chars: triageMd.length },
      });
      if (triageMd.trim()) {
        const store = new ArtifactStore({
          rootDir: artifactsDir,
          runId,
        });
        const ref = store.writeText("llm_output", triageMd, {
          ext: "md",
          metadata: { phase: "triage", kind: "triage_md" },
        });
        insertArtifact(ctx.db, {
          id: ref.id,
          run_id: runId,
          type: ref.type,
          path: join(artifactsDir, ref.path),
          sha256: ref.sha256,
          created_at: ref.createdAt,
          metadata_json: ref.metadata ? JSON.stringify(ref.metadata) : null,
        });
        resultOut = {
          ...result,
          artifacts: [...result.artifacts, ref],
        };
      }
    }

    // Write report + summary
    const runDir = join(runsDir, runId);
    ensureDir(runDir);
    const reportPath = join(runDir, "report.json");
    const summaryPath = join(runDir, "summary.md");
    writeFileSync(reportPath, JSON.stringify(resultOut, null, 2), "utf8");
    writeFileSync(summaryPath, synthesizeMarkdownSummary(resultOut), "utf8");

    updateRunStatus(
      ctx.db,
      runId,
      resultOut.overall_status,
      resultOut.confidence,
    );

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
      status: resultOut.overall_status,
      confidence: resultOut.confidence,
    });
    opts?.onEvent?.({
      type: "run_finished",
      runId,
      endedAt,
      status: resultOut.overall_status,
      confidence: resultOut.confidence,
    });

    return { runId, result: resultOut };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const aborted =
      (e instanceof Error && e.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        e instanceof DOMException &&
        e.name === "AbortError");
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

    updateRunStatus(ctx.db, runId, aborted ? "timed_out" : "error", 0);
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
      status: aborted ? "timed_out" : "error",
      confidence: 0,
    });
    throw e;
  } finally {
    if (launchChild && !launchChild.killed) {
      try {
        launchChild.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    // Best-effort: unload any Ollama models used during this run to free RAM.
    // Do NOT kill the Ollama daemon; just ask it to stop the model(s).
    if (policyUsesOllama(llmPolicy) && ollamaModelsUsed.size > 0) {
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
