import { readFileSync } from "node:fs";
import { Command } from "commander";
import pino from "pino";
import {
  loadProjectConfig,
  mergeLlmPolicyWithProjectProfile,
} from "../../config/projectConfig.js";
import type { VerificationResult } from "../../core/result.js";
import { LlmPolicySchema } from "../../llm/types.js";
import {
  chromeDevtoolsListTools,
  chromeDevtoolsSelfCheck,
  closeOpsContext,
  createOpsContext,
  modelList,
  modelPull,
  modelSuggest,
  ollamaStatus,
  verifySpec,
} from "../../ops/index.js";
import { readCliPackageVersion } from "./packageVersion.js";
import {
  loadVerifyCliConfigFile,
  type ResolvedVerifyCli,
  resolveVerifyCliOptions,
} from "./verifyCliConfig.js";
import {
  createVerifyRunPrinter,
  printVerifyPreamble,
} from "./verifyRunPrinter.js";

const logger = pino({ name: "checkirai" }, pino.destination(2));

export async function main(argv = process.argv) {
  const program = new Command()
    .name("checkirai")
    .description("Spec-driven verification runtime (CLI)")
    .version(readCliPackageVersion(), "-V, --version")
    .showHelpAfterError()
    .showSuggestionAfterError();

  program
    .command("verify")
    .description("Verify a target implementation against a markdown spec")
    .option(
      "-c, --config <path>",
      "JSON file with verify defaults (merged with flags below; explicit CLI options override the file)",
    )
    .option(
      "--spec <path>",
      "Path to spec markdown file (required unless --restart-from spec_ir|llm_plan with --restart-run)",
    )
    .option(
      "--target <url>",
      "Target base URL (or set `target` in --config / defaults.targetUrl in checkirai.config.json)",
    )
    .option(
      "--tools <list>",
      "Comma-separated tools: playwright-mcp,shell,fs,http",
    )
    .option("--out <dir>", "Output directory root")
    .option("--policy <name>", "Policy name: read_only|ui_only")
    .option(
      "--llm-provider <provider>",
      "ollama|remote|none (applies to all roles when set)",
    )
    .option("--ollama-host <url>", "Ollama host")
    .option(
      "--ollama-model <name>",
      "Override Ollama model tag for all roles (omit to use config per-role defaults)",
    )
    .option("--allow-auto-pull", "Allow pulling missing Ollama models", true)
    .option(
      "--restart-from <phase>",
      "Reuse artifacts from --restart-run: start | spec_ir | llm_plan",
    )
    .option(
      "--restart-run <runId>",
      "Parent run UUID (required when --restart-from is not start)",
    )
    .option("--plain", "Disable ANSI colors (recording-friendly)")
    .option("--verbose", "Include full LLM prompt/response text in the stream")
    .action(async (opts) => {
      const projectCfg = loadProjectConfig();
      let file: ReturnType<typeof loadVerifyCliConfigFile> | null = null;
      const cfgArg =
        typeof opts.config === "string" && opts.config.trim()
          ? opts.config.trim()
          : null;
      if (cfgArg) {
        try {
          file = loadVerifyCliConfigFile(cfgArg);
        } catch (e) {
          logger.error(
            { err: e },
            `Failed to read verify config file: ${cfgArg}`,
          );
          process.exitCode = 2;
          return;
        }
      }

      let merged: ResolvedVerifyCli;
      try {
        merged = resolveVerifyCliOptions({
          argv,
          file,
          projectDefaults: projectCfg.config?.defaults,
          rawCommander: opts as Record<string, unknown>,
        });
      } catch (e) {
        logger.error(
          { err: e },
          e instanceof Error ? e.message : "Invalid verify options.",
        );
        process.exitCode = 2;
        return;
      }

      const restartFrom = merged.restartFrom;
      const restartRunId = merged.restartRun;

      if (restartFrom !== "start" && !restartRunId) {
        logger.error(
          "--restart-run <runId> is required when --restart-from is not start.",
        );
        process.exitCode = 2;
        return;
      }
      if (restartFrom === "start" && !merged.specPath) {
        logger.error(
          "Spec path is required unless restarting from a previous run (--restart-from spec_ir|llm_plan --restart-run <runId>). Set `spec` in --config or pass --spec <path>.",
        );
        process.exitCode = 2;
        return;
      }

      const baseLlm = mergeLlmPolicyWithProjectProfile(
        LlmPolicySchema.parse(projectCfg.config?.llm ?? {}),
        projectCfg.config ?? undefined,
      );
      const prov = merged.llmProvider;
      let llmPolicy: ReturnType<typeof LlmPolicySchema.parse>;
      if (prov === "none") {
        const off = { provider: "none" as const, model: "disabled" };
        llmPolicy = LlmPolicySchema.parse({
          ...baseLlm,
          normalizer: { ...baseLlm.normalizer, ...off },
          plannerAssist: { ...baseLlm.plannerAssist, ...off },
          judge: { ...baseLlm.judge, ...off },
          triage: { ...baseLlm.triage, ...off },
        });
      } else {
        llmPolicy = LlmPolicySchema.parse({
          ...baseLlm,
          ollamaHost: merged.ollamaHost,
          allowAutoPull: merged.allowAutoPull,
        });
      }
      if (prov !== "none" && merged.ollamaModel) {
        const m = merged.ollamaModel;
        llmPolicy = LlmPolicySchema.parse({
          ...llmPolicy,
          normalizer: { ...llmPolicy.normalizer, model: m },
          plannerAssist: { ...llmPolicy.plannerAssist, model: m },
          judge: { ...llmPolicy.judge, model: m },
          triage: { ...llmPolicy.triage, model: m },
        });
      }

      const useColor = !opts.plain;
      printVerifyPreamble({
        color: useColor,
        projectConfigPath: projectCfg.path,
        cwd: process.cwd(),
        llmPolicy,
        ollamaHost: merged.ollamaHost,
        ...(process.env.CHECKIRAI_PROFILE?.trim()
          ? { envProfile: process.env.CHECKIRAI_PROFILE.trim() }
          : {}),
        ...(projectCfg.config?.defaults?.profile?.trim()
          ? { defaultsProfile: projectCfg.config.defaults.profile.trim() }
          : {}),
      });

      const specMd =
        typeof merged.specPath === "string" && merged.specPath.trim()
          ? readFileSync(merged.specPath, "utf8")
          : undefined;
      const specLabel =
        typeof merged.specPath === "string" && merged.specPath.trim()
          ? merged.specPath.trim()
          : restartFrom !== "start"
            ? `(restart from ${restartFrom})`
            : "(none)";

      const printer = createVerifyRunPrinter({
        color: useColor,
        verbose: Boolean(opts.verbose),
        headline: {
          target: merged.target,
          specLabel,
          outDir: merged.out,
        },
      });

      const ctx = createOpsContext({ outRoot: merged.out });
      const interrupt = new AbortController();
      let sigHits = 0;
      const onSig = () => {
        sigHits++;
        if (sigHits === 1) {
          interrupt.abort();
          logger.warn(
            "Interrupt: stopping verification (MCP and Ollama models unload after the current step)…",
          );
        } else {
          logger.error("Second interrupt: exiting immediately.");
          process.exit(130);
        }
      };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);

      const toolSet = new Set(
        merged.tools
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const chromeDevtoolsServerRaw =
        projectCfg.config?.mcpServers?.["chrome-devtools"] ?? null;
      const chromeDevtoolsServer = chromeDevtoolsServerRaw
        ? {
            command: chromeDevtoolsServerRaw.command,
            ...(chromeDevtoolsServerRaw.args
              ? { args: chromeDevtoolsServerRaw.args }
              : {}),
            ...(chromeDevtoolsServerRaw.cwd
              ? { cwd: chromeDevtoolsServerRaw.cwd }
              : {}),
            ...(chromeDevtoolsServerRaw.env
              ? { env: chromeDevtoolsServerRaw.env }
              : {}),
          }
        : null;
      const restartPayload =
        restartFrom !== "start" && restartRunId
          ? { restartFromPhase: restartFrom, restartFromRunId: restartRunId }
          : {};

      let result: VerificationResult;
      let completedRunId = "";
      try {
        const out = await verifySpec(
          ctx,
          {
            ...(specMd !== undefined ? { specMarkdown: specMd } : {}),
            targetUrl: merged.target,
            tools: merged.tools,
            policyName: merged.policy,
            llm: llmPolicy,
            outDir: merged.out,
            ...restartPayload,
            ...(toolSet.has("chrome-devtools") && chromeDevtoolsServer
              ? { chromeDevtoolsServer }
              : {}),
          },
          { onEvent: printer.onEvent, signal: interrupt.signal },
        );
        completedRunId = out.runId;
        result = out.result;
      } catch (e) {
        if (interrupt.signal.aborted) {
          process.exitCode = 130;
          logger.warn(
            { err: e },
            "Verification interrupted (run marked cancelled in the database).",
          );
          return;
        }
        logger.error(
          { err: e },
          e instanceof Error ? e.message : "verify_spec failed",
        );
        process.exitCode = 3;
        return;
      } finally {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
        closeOpsContext(ctx);
      }

      printer.printSummary(result);

      const code =
        result.overall_status === "pass"
          ? 0
          : result.overall_status === "fail"
            ? 1
            : result.overall_status === "inconclusive"
              ? 2
              : 3;
      logger.info(
        { runId: completedRunId, status: result.overall_status },
        "Verification completed.",
      );
      process.exitCode = code;
    });

  const ollama = program.command("ollama").description("Ollama operations");
  ollama
    .command("status")
    .description("Check if Ollama is reachable")
    .option("--host <url>", "Ollama host", "http://127.0.0.1:11434")
    .action(async (opts) => {
      const ctx = createOpsContext();
      const status = await ollamaStatus(ctx, { host: String(opts.host) });
      if (!status.ok) {
        logger.error(status.error?.message ?? "Ollama not running.");
        process.exitCode = 3;
        return;
      }
      logger.info(
        { host: status.host, version: status.version },
        "Ollama is running.",
      );
      process.exitCode = 0;
    });

  const model = program.command("model").description("Local model management");
  model
    .command("list")
    .description("List installed Ollama models")
    .option("--host <url>", "Ollama host", "http://127.0.0.1:11434")
    .action(async (opts) => {
      const ctx = createOpsContext();
      const out = await modelList(ctx, { host: String(opts.host) });
      for (const m of out.models)
        logger.info({ name: m.name, size: m.size }, "model");
      process.exitCode = 0;
    });

  model
    .command("suggest")
    .description("Suggest recommended models for tooling/structured output")
    .option("--tooling", "Prefer models suited for structured outputs", true)
    .action((opts) => {
      const ctx = createOpsContext();
      const recs = modelSuggest(ctx, { requireTooling: Boolean(opts.tooling) });
      logger.info(recs.hardware, "host_ram_hardware_hint");
      for (const r of recs.modelsMatchingRam ?? [])
        logger.info(
          { name: r.name, notes: r.notes, approxQ4RamGiB: r.approxQ4RamGiB },
          "recommended_for_ram",
        );
      for (const r of recs.models)
        logger.info({ name: r.name, notes: r.notes }, "recommended_all");
      process.exitCode = 0;
    });

  model
    .command("pull")
    .description("Download a model via Ollama")
    .argument("<modelName>", "Model to pull, e.g. llama3.1:8b-instruct")
    .option("--host <url>", "Ollama host", "http://127.0.0.1:11434")
    .action(async (modelName, opts) => {
      const ctx = createOpsContext();
      await modelPull(ctx, {
        host: String(opts.host),
        modelName: String(modelName),
      });
      process.exitCode = 0;
    });

  const chrome = program
    .command("chrome-devtools")
    .description("Chrome DevTools MCP diagnostics");
  chrome
    .command("list-tools")
    .description(
      "Spawn the Chrome DevTools MCP server and list tools it exposes",
    )
    .requiredOption(
      "--command <cmd>",
      "Command to launch the MCP server process",
    )
    .option("--args <args>", "Arguments (space-separated)", "")
    .option("--cwd <cwd>", "Working directory", process.cwd())
    .action(async (opts) => {
      const ctx = createOpsContext();
      const args = String(opts.args || "")
        .split(" ")
        .map((s) => s.trim())
        .filter(Boolean);
      const out = await chromeDevtoolsListTools(ctx, {
        command: String(opts.command),
        args,
        cwd: String(opts.cwd),
      });
      for (const t of out.tools)
        logger.info({ name: t.name, description: t.description }, "tool");
      process.exitCode = 0;
    });

  chrome
    .command("self-check")
    .description(
      "Verify the Chrome DevTools MCP server supports the expected tool surface",
    )
    .requiredOption(
      "--command <cmd>",
      "Command to launch the MCP server process",
    )
    .option("--args <args>", "Arguments (space-separated)", "")
    .option("--cwd <cwd>", "Working directory", process.cwd())
    .action(async (opts) => {
      const ctx = createOpsContext();
      const args = String(opts.args || "")
        .split(" ")
        .map((s) => s.trim())
        .filter(Boolean);
      const out = await chromeDevtoolsSelfCheck(ctx, {
        command: String(opts.command),
        args,
        cwd: String(opts.cwd),
      });
      if (out.ok) {
        logger.info(
          { count: out.count },
          "Chrome DevTools MCP tool surface looks good.",
        );
        if (out.extra.length)
          logger.info({ extra: out.extra }, "Extra tools available (fine).");
        process.exitCode = 0;
      } else {
        logger.error(
          { missing: out.missing, extra: out.extra },
          "Chrome DevTools MCP missing expected tools.",
        );
        process.exitCode = 3;
      }
    });

  await program.parseAsync(argv);
}

// Allow `tsx src/interfaces/cli/index.ts`
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void main();
}
