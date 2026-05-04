import type { VerificationResult } from "../../core/result.js";
import type { LlmPolicy } from "../../llm/types.js";
import type { RunEvent } from "../../ops/events.js";
import { createTermPalette, verdictColor } from "./termStyle.js";

/** Prints cwd, resolved project config path, and effective per-role models before any heavy work. */
export function printVerifyPreamble(opts: {
  color: boolean;
  projectConfigPath: string | null;
  cwd: string;
  llmPolicy: LlmPolicy;
  ollamaHost: string;
  envProfile?: string;
  defaultsProfile?: string;
}) {
  const t = createTermPalette({ color: opts.color });
  const cols = process.stdout.columns ?? 80;
  const w = (s: string) => {
    process.stdout.write(`${s}\n`);
  };
  w("");
  w(`${t.bold}${t.cyan}checkirai verify${t.reset}`);
  w(`${t.dim}cwd${t.reset}              ${opts.cwd}`);
  if (opts.projectConfigPath) {
    w(`${t.dim}project config${t.reset}   ${opts.projectConfigPath}`);
  } else {
    w(
      `${t.yellow}project config${t.reset}   (not found — searched cwd and parents; using built-in LLM defaults)`,
    );
  }
  if (opts.defaultsProfile) {
    w(`${t.dim}defaults.profile${t.reset} ${opts.defaultsProfile}`);
  }
  if (opts.envProfile) {
    w(`${t.dim}CHECKIRAI_PROFILE${t.reset} ${opts.envProfile}`);
  }
  w(`${t.dim}Ollama host${t.reset}       ${opts.ollamaHost}`);
  const p = opts.llmPolicy;
  w(`${t.dim}Models (effective)${t.reset}`);
  w(
    `  ${t.dim}normalizer${t.reset}     ${p.normalizer.provider}  ${p.normalizer.model}`,
  );
  w(
    `  ${t.dim}plannerAssist${t.reset}  ${p.plannerAssist.provider}  ${p.plannerAssist.model}`,
  );
  w(`  ${t.dim}judge${t.reset}          ${p.judge.provider}  ${p.judge.model}`);
  w(
    `  ${t.dim}triage${t.reset}        ${p.triage.provider}  ${p.triage.model}`,
  );
  w(`${t.dim}${"─".repeat(Math.min(72, cols - 1))}${t.reset}`);
  w("");
}

function formatLiveStepLabel(e: RunEvent): string | null {
  if (e.type === "step_started") {
    const cap =
      typeof e.capability === "string" ? e.capability : String(e.capability);
    const act = typeof e.action === "string" ? e.action : String(e.action);
    return `${cap} › ${act}`;
  }
  if (e.type === "probe_started") {
    const pid = typeof e.probeId === "string" ? e.probeId.slice(0, 8) : "probe";
    const req =
      typeof e.requirementId === "string" && e.requirementId
        ? ` req ${e.requirementId}`
        : "";
    return `probe ${pid}…${req}`;
  }
  if (e.type === "run_started") return "Starting verification…";
  if (e.type === "run_queued") return "Run queued";
  return null;
}

function tsShort(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 23);
}

function clip(s: string, max: number) {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function createVerifyRunPrinter(opts: {
  color: boolean;
  verbose: boolean;
  headline: { target: string; specLabel: string; outDir: string };
}) {
  const t = createTermPalette({ color: opts.color });
  const cols = process.stdout.columns ?? 80;
  let headerDone = false;

  const line = (s: string) => {
    process.stdout.write(`${s}\n`);
  };

  const printHeaderOnce = (runId: string) => {
    if (headerDone) return;
    headerDone = true;
    line("");
    line(
      `${t.bold}${t.cyan}checkirai verify${t.reset}  ${t.dim}${tsShort(new Date().toISOString())}${t.reset}`,
    );
    line(`${t.dim}Run ID${t.reset}  ${runId}`);
    line(`${t.dim}Target${t.reset} ${opts.headline.target}`);
    line(`${t.dim}Spec${t.reset}   ${opts.headline.specLabel}`);
    line(`${t.dim}Out${t.reset}     ${opts.headline.outDir}`);
    line(`${t.dim}${"─".repeat(Math.min(cols - 1, 72))}${t.reset}`);
  };

  const onEvent = (e: RunEvent) => {
    printHeaderOnce(e.runId);

    switch (e.type) {
      case "run_queued":
        line(
          `${t.dim}●${t.reset} ${t.cyan}queued${t.reset}  ${e.createdAt ? tsShort(e.createdAt) : ""}`,
        );
        break;
      case "run_started":
        line(
          `${t.dim}●${t.reset} ${t.green}run${t.reset}     ${formatLiveStepLabel(e) ?? "started"}`,
        );
        break;
      case "run_error": {
        const msg = clip(e.message, cols - 8);
        line(`${t.red}✖ run_error${t.reset} ${msg}`);
        break;
      }
      case "probe_started": {
        const lab = formatLiveStepLabel(e);
        if (lab) line(`${t.dim}›${t.reset} ${t.blue}${lab}${t.reset}`);
        break;
      }
      case "step_started": {
        const lab = formatLiveStepLabel(e);
        if (lab) line(`${t.dim}›${t.reset} ${t.cyan}${lab}${t.reset}`);
        break;
      }
      case "step_finished": {
        const lab =
          typeof e.capability === "string" && typeof e.action === "string"
            ? `${e.capability} › ${e.action}`
            : "step";
        const ok = e.ok;
        const mark = ok ? `${t.green}✓${t.reset}` : `${t.red}✗${t.reset}`;
        const err =
          !ok && e.errorMessage
            ? ` ${t.dim}${clip(e.errorMessage, cols - 24)}${t.reset}`
            : "";
        line(`${mark} ${t.dim}${lab}${t.reset}${err}`);
        break;
      }
      case "llm_call": {
        const phase = String(e.phase ?? "");
        const model = String(e.model ?? "");
        const ms = typeof e.durationMs === "number" ? `${e.durationMs}ms` : "";
        const pc = typeof e.promptChars === "number" ? e.promptChars : 0;
        const rc = typeof e.responseChars === "number" ? e.responseChars : 0;
        line(
          `${t.magenta}LLM${t.reset} ${t.dim}${phase}${t.reset}  ${model}  ${t.dim}${ms}  ${pc}→${rc} chars${t.reset}`,
        );
        if (opts.verbose) {
          if (typeof e.system === "string" && e.system.trim())
            line(`${t.dim}system:${t.reset}\n${clip(e.system, 2000)}`);
          if (typeof e.prompt === "string" && e.prompt.trim())
            line(`${t.dim}prompt:${t.reset}\n${clip(e.prompt, 4000)}`);
          if (typeof e.responseText === "string" && e.responseText.trim())
            line(`${t.dim}response:${t.reset}\n${clip(e.responseText, 4000)}`);
        }
        break;
      }
      case "run_finished": {
        const st = String(e.status ?? "");
        const vc = verdictColor(t, st);
        line(
          `${t.bold}Finished${t.reset}  ${vc.open}${st.toUpperCase()}${vc.close}` +
            (typeof e.confidence === "number"
              ? `  ${t.dim}confidence ${(e.confidence * 100).toFixed(0)}%${t.reset}`
              : ""),
        );
        break;
      }
      default:
        break;
    }
  };

  const printSummary = (result: VerificationResult) => {
    line("");
    line(`${t.bold}Requirements${t.reset}`);
    const cov = result.coverage_summary;
    line(
      `${t.dim}Coverage${t.reset}  total ${cov.total}  ${t.green}pass ${cov.pass}${t.reset}  ${t.red}fail ${cov.fail}${t.reset}  ${t.yellow}inconclusive ${cov.inconclusive}${t.reset}  ${t.magenta}blocked ${cov.blocked}${t.reset}`,
    );
    line("");
    const idW = Math.min(
      28,
      Math.max(10, ...result.requirements.map((r) => r.requirement_id.length)),
    );
    for (const r of result.requirements) {
      const vc = verdictColor(t, r.verdict);
      const id = r.requirement_id.padEnd(idW).slice(0, idW);
      line(
        `  ${vc.open}${String(r.verdict).padEnd(14)}${vc.close} ${t.dim}${id}${t.reset}  ${t.dim}${(r.judgment_mode ?? "").padEnd(18)}${t.reset}  ${t.dim}${(r.confidence * 100).toFixed(0)}%${t.reset}`,
      );
      if (r.why_failed_or_blocked?.trim()) {
        line(
          `           ${t.dim}${clip(r.why_failed_or_blocked.trim(), cols - 12)}${t.reset}`,
        );
      }
    }
    line("");
    line(
      `${t.dim}Trace${t.reset}  toolCalls ${result.tool_trace_summary.toolCalls}  sessions ${result.tool_trace_summary.sessions}  ${result.tool_trace_summary.durationMs}ms`,
    );
    if (result.blocked_reasons?.length) {
      line(`${t.yellow}Blocked reasons:${t.reset}`);
      for (const b of result.blocked_reasons)
        line(`  ${t.dim}•${t.reset} ${clip(b, cols - 4)}`);
    }
    if (result.suggested_repairs?.length) {
      line(`${t.cyan}Suggested repairs:${t.reset}`);
      for (const s of result.suggested_repairs)
        line(`  ${t.dim}•${t.reset} ${clip(s, cols - 4)}`);
    }
    line("");
  };

  return { onEvent, printSummary, palette: t };
}

export type VerifyRunPrinter = ReturnType<typeof createVerifyRunPrinter>;
