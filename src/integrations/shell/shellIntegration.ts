import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VerifierError } from "../../shared/errors.js";

const execFileAsync = promisify(execFile);

export type ShellIntegration = {
  run(
    command: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

export function createShellIntegration(opts?: {
  allowCommands?: string[];
}): ShellIntegration {
  const allow = new Set(opts?.allowCommands ?? []);

  const assertAllowed = (cmd: string) => {
    if (allow.size === 0) {
      throw new VerifierError(
        "POLICY_BLOCKED",
        "Shell execution is disabled by policy (no allowCommands configured).",
      );
    }
    if (!allow.has(cmd)) {
      throw new VerifierError(
        "POLICY_BLOCKED",
        `Shell command not allowed: ${cmd}`,
        {
          details: { cmd, allowCommands: [...allow] },
        },
      );
    }
  };

  return {
    async run(command, args, runOpts) {
      assertAllowed(command);
      try {
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd: runOpts?.cwd,
          timeout: runOpts?.timeoutMs ?? 60_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
      } catch (cause: unknown) {
        const c = cause as {
          code?: unknown;
          stdout?: unknown;
          stderr?: unknown;
        };
        const exitCode = typeof c?.code === "number" ? (c.code as number) : 1;
        return {
          stdout: typeof c?.stdout === "string" ? c.stdout : "",
          stderr: typeof c?.stderr === "string" ? c.stderr : String(cause),
          exitCode,
        };
      }
    },
  };
}
