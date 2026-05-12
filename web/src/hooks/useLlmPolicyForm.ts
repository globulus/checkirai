import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  type LlmPolicy,
  type LlmRole,
  type LlmRoleConfig,
  summarizeLlmPolicyForRun,
} from "../../../src/llm/types.js";
import { LLM_ROLES, patchLlmRole } from "../lib/llmUi";
import type { ModelCatalog } from "../types/dashboard";

export function useLlmPolicyForm(
  llmPolicy: LlmPolicy,
  setLlmPolicy: Dispatch<SetStateAction<LlmPolicy>>,
  modelCatalog: ModelCatalog | null,
) {
  const [modelAssignRole, setModelAssignRole] = useState<LlmRole>("judge");

  const updateLlmRole = useCallback(
    (role: LlmRole, patch: Partial<LlmRoleConfig>) => {
      setLlmPolicy((p) => patchLlmRole(p, role, patch));
    },
    [setLlmPolicy],
  );

  const llmRunSummary = useMemo(
    () => summarizeLlmPolicyForRun(llmPolicy),
    [llmPolicy],
  );

  const availableOllamaModels = useMemo(() => {
    const installed = (modelCatalog?.installed ?? [])
      .map((m) => (typeof m?.name === "string" ? m.name : null))
      .filter(Boolean) as string[];
    const recommended = (modelCatalog?.recommended ?? [])
      .map((m) => (typeof m?.name === "string" ? m.name : null))
      .filter(Boolean) as string[];
    const fromPolicy = new Set<string>();
    for (const role of LLM_ROLES) {
      const rc = llmPolicy[role];
      if (rc.provider !== "ollama") continue;
      if (rc.model.trim()) fromPolicy.add(rc.model.trim());
      if (rc.fallbackModel?.trim()) fromPolicy.add(rc.fallbackModel.trim());
    }
    const all = Array.from(
      new Set([...installed, ...recommended, ...fromPolicy]),
    );
    if (all.length === 0) all.push("qwen2.5:14b-instruct");
    return all.sort((a, b) => a.localeCompare(b));
  }, [modelCatalog, llmPolicy]);

  return {
    modelAssignRole,
    setModelAssignRole,
    updateLlmRole,
    llmRunSummary,
    availableOllamaModels,
  };
}
