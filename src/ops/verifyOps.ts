import { policyJudgeOrPlannerActive } from "../llm/types.js";
import { insertRequirements } from "../persistence/repo/requirementRepo.js";
import type { OpsContext } from "./context.js";
import type { RunEventSink } from "./events.js";
import { cleanupRun } from "./verify/cleanupRun.js";
import { finalizeRun } from "./verify/finalizeRun.js";
import { runGenericLlmFlow } from "./verify/genericLlmFlow.js";
import { handleRunFailure } from "./verify/handleRunFailure.js";
import { initVerifyRun } from "./verify/initRun.js";
import { runLegacyProbeFlow } from "./verify/legacyProbeFlow.js";
import { runPreflight } from "./verify/preflight.js";
import { resolveSpec } from "./verify/resolveSpec.js";
import type { VerifySpecInput } from "./verify/types.js";

export {
  RestartFromPhaseSchema,
  type RestartFromPhase,
  type VerifySpecInput,
} from "./verify/types.js";

export async function verifySpec(
  ctx: OpsContext,
  input: VerifySpecInput,
  opts?: { onEvent?: RunEventSink; runId?: string; signal?: AbortSignal },
) {
  const run = initVerifyRun(ctx, input, opts);

  try {
    await resolveSpec(run);
    const { integrationRuntime, integrations } = await runPreflight(run);

    const canUseGenericLlmLoop =
      policyJudgeOrPlannerActive(run.llmPolicy) &&
      integrationRuntime.hasMcpToolHost();

    if (run.restartFromPhase === "llm_plan" && !canUseGenericLlmLoop) {
      throw new Error(
        "restart from llm_plan requires chrome-devtools or dart-mcp in tools and an LLM provider other than none (same conditions as the generic plan→execute path).",
      );
    }

    let execOut: { toolCalls: any[]; artifacts: any[] } | undefined;
    let requirementResults: any[] | undefined;
    let metaExtra: Record<string, unknown> = {};

    insertRequirements(
      run.ctx.db,
      run.specIr!.requirements.map((r) => ({
        run_id: run.runId,
        id: r.id,
        source_text: r.source_text,
        type: r.type,
        priority: r.priority,
      })),
    );

    try {
      if (canUseGenericLlmLoop && integrationRuntime.hasMcpToolHost()) {
        const generic = await runGenericLlmFlow(run, integrationRuntime);
        execOut = generic.execOut;
        requirementResults = generic.requirementResults;
        metaExtra = generic.meta;
      } else {
        const legacy = await runLegacyProbeFlow(
          run,
          integrationRuntime,
          integrations,
        );
        execOut = legacy.execOut;
        requirementResults = legacy.requirementResults;
        metaExtra = legacy.meta;
      }
    } finally {
      await integrationRuntime.closeAll();
    }

    if (!execOut || !requirementResults) {
      throw new Error("Internal error: missing execution/judgment outputs.");
    }

    return await finalizeRun(run, execOut, requirementResults, metaExtra);
  } catch (e: unknown) {
    handleRunFailure(run, e);
  } finally {
    await cleanupRun(run);
  }
}
