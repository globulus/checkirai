import { VerifierError } from "../shared/errors.js";

export type PolicyName = "read_only" | "ui_only";

export type Policy = {
  name: PolicyName;
  allowHttp: boolean;
  allowShell: boolean;
  allowUiInteraction: boolean;
};

export function getPolicy(name: PolicyName): Policy {
  switch (name) {
    case "read_only":
      return {
        name,
        allowHttp: true,
        allowShell: false,
        allowUiInteraction: false,
      };
    case "ui_only":
      return {
        name,
        allowHttp: false,
        allowShell: false,
        allowUiInteraction: true,
      };
  }
}

export function assertPolicyAllows(policy: Policy, capability: string) {
  if (capability === "call_http" && !policy.allowHttp) {
    throw new VerifierError("POLICY_BLOCKED", "HTTP is disabled by policy.");
  }
  if (capability === "run_command" && !policy.allowShell) {
    throw new VerifierError(
      "POLICY_BLOCKED",
      "Shell execution is disabled by policy.",
    );
  }
  if (capability === "interact" && !policy.allowUiInteraction) {
    throw new VerifierError(
      "POLICY_BLOCKED",
      "UI interaction is disabled by policy.",
    );
  }
}
