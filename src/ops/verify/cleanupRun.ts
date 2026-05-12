import { ollamaStopModel } from "../../llm/ollamaCli.js";
import { policyUsesOllama } from "../../llm/types.js";
import type { VerifyRunContext } from "./context.js";

export async function cleanupRun(run: VerifyRunContext) {
  run.disposeRunAbort();
  if (run.launchChild.current && !run.launchChild.current.killed) {
    try {
      run.launchChild.current.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  if (policyUsesOllama(run.llmPolicy) && run.ollamaModelsUsed.size > 0) {
    await Promise.all(
      [...run.ollamaModelsUsed].map((model) =>
        ollamaStopModel({ host: run.llmPolicy.ollamaHost, model }).catch(
          () => ({
            ok: false,
          }),
        ),
      ),
    );
  }
}
