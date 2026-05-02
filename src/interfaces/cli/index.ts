import { readFileSync } from "node:fs";
import { Command } from "commander";
import pino from "pino";
import { loadProjectConfig } from "../../config/projectConfig.js";
import { LlmPolicySchema } from "../../llm/types.js";
import {
  chromeDevtoolsListTools,
  chromeDevtoolsSelfCheck,
  createOpsContext,
  modelList,
  modelPull,
  modelSuggest,
  ollamaStatus,
  RestartFromPhaseSchema,
  verifySpec,
} from "../../ops/index.js";

const logger = pino({ name: "checkirai" });

export async function main(argv = process.argv) {
  const program = new Command()
    .name("checkirai")
    .description("Spec-driven verification runtime (CLI)")
    .showHelpAfterError()
    .showSuggestionAfterError();

  program
    .command("verify")
    .description("Verify a target implementation against a markdown spec")
    .option(
      "--spec <path>",
      "Path to spec markdown file (required unless --restart-from spec_ir|llm_plan with --restart-run)",
    )
    .requiredOption("--target <url>", "Target base URL")
    .option(
      "--tools <list>",
      "Comma-separated tools: playwright-mcp,shell,fs,http",
      "fs,http",
    )
    .option("--out <dir>", "Output directory root", ".verifier")
    .option("--policy <name>", "Policy name: read_only|ui_only", "read_only")
    .option("--llm-provider <provider>", "ollama|remote|none", "ollama")
    .option("--ollama-host <url>", "Ollama host", "http://127.0.0.1:11434")
    .option("--ollama-model <name>", "Ollama model name or 'auto'", "auto")
    .option("--allow-auto-pull", "Allow pulling missing Ollama models", true)
    .option(
      "--restart-from <phase>",
      "Reuse artifacts from --restart-run: start | spec_ir | llm_plan",
      "start",
    )
    .option(
      "--restart-run <runId>",
      "Parent run UUID (required when --restart-from is not start)",
    )
    .action(async (opts) => {
      const restartFromRaw = String(opts.restartFrom ?? "start");
      const restartFrom = RestartFromPhaseSchema.parse(restartFromRaw);
      const restartRunId =
        typeof opts.restartRun === "string" && opts.restartRun.trim()
          ? opts.restartRun.trim()
          : undefined;

      if (restartFrom !== "start" && !restartRunId) {
        logger.error(
          "--restart-run <runId> is required when --restart-from is not start.",
        );
        process.exitCode = 2;
        return;
      }
      if (restartFrom === "start" && !opts.spec) {
        logger.error(
          "--spec is required unless restarting from a previous run (--restart-from spec_ir|llm_plan --restart-run <runId>).",
        );
        process.exitCode = 2;
        return;
      }

      const llmPolicy = LlmPolicySchema.parse({
        provider: opts.llmProvider,
        ollamaHost: opts.ollamaHost,
        ollamaModel: opts.ollamaModel,
        allowAutoPull: Boolean(opts.allowAutoPull),
      });

      const specMd =
        typeof opts.spec === "string" && opts.spec.trim()
          ? readFileSync(String(opts.spec), "utf8")
          : undefined;
      const ctx = createOpsContext({ outRoot: String(opts.out) });
      const toolSet = new Set(
        String(opts.tools ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const projectCfg = loadProjectConfig();
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

      const { runId, result } = await verifySpec(ctx, {
        ...(specMd !== undefined ? { specMarkdown: specMd } : {}),
        targetUrl: String(opts.target),
        tools: String(opts.tools),
        policyName: String(opts.policy) === "ui_only" ? "ui_only" : "read_only",
        llm: llmPolicy,
        outDir: String(opts.out),
        ...restartPayload,
        ...(toolSet.has("chrome-devtools") && chromeDevtoolsServer
          ? { chromeDevtoolsServer }
          : {}),
      });

      const code =
        result.overall_status === "pass"
          ? 0
          : result.overall_status === "fail"
            ? 1
            : result.overall_status === "inconclusive"
              ? 2
              : 3;
      logger.info(
        { runId, status: result.overall_status },
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
      for (const r of recs.models)
        logger.info({ name: r.name, notes: r.notes }, "recommended");
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
