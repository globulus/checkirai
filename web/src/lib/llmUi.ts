import type {
  LlmPolicy,
  LlmRole,
  LlmRoleConfig,
} from "../../../src/llm/types.js";

export const LLM_ROLES: LlmRole[] = [
  "normalizer",
  "plannerAssist",
  "judge",
  "triage",
];

export const ROLE_LABELS: Record<LlmRole, string> = {
  normalizer: "Normalizer",
  plannerAssist: "Planner assist",
  judge: "Judge",
  triage: "Triage",
};

export function patchLlmRole(
  policy: LlmPolicy,
  role: LlmRole,
  patch: Partial<LlmRoleConfig>,
): LlmPolicy {
  return {
    ...policy,
    [role]: { ...policy[role], ...patch },
  };
}
