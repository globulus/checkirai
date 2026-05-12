```text
  / __|  | || |   | __|   / __|  | |/ /   |_ _|   | _ \     o O O  /   \   |_ _|
 | (__   | __ |   | _|   | (__   | ' <     | |    |   /    o       | - |    | |
  \___|  |_||_|   |___|   \___|  |_|\_\   |___|   |_|_\   TS__[O]  |_|_|   |___|
_|"""""|_|"""""|_|"""""|_|"""""|_|"""""|_|"""""|_|"""""| {======|_|"""""|_|"""""|
"`-0-0-'"`-0-0-'"`-0-0-'"`-0-0-'"`-0-0-'"`-0-0-'"`-0-0-'./o--000'"`-0-0-'"`-0-0-'
```

> **Local LLMs + MCP-backed tools = test your builds locally without paying token costs!**
> Parse specs, plan probes, collect evidence and return requirement-level verdicts.

[![Build](https://github.com/globulus/checkirai/actions/workflows/node.js.yml/badge.svg?branch=main)](https://github.com/globulus/checkirai/actions/workflows/node.js.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Checkir AI** is a spec-driven verification runtime: it reads a human-readable spec, plans probes, runs tools (including MCP-backed capabilities) and returns **requirement-level verdicts** — pass, fail, inconclusive, or blocked — with evidence you can inspect offline. LLM-assisted phases default to **Ollama** on your machine; you can also use a **`remote`** provider (OpenAI-compatible HTTP API) for normalization and judging. Tool hosts connect over **MCP** the same way Cursor or Claude Code talks to other servers.

![GIF demo](./fixtures/demo.gif)

---

## Why?

- **Tokens and API calls add up.** Re-running the same “does the UI match the spec?” loop through a cloud model is slow and expensive.
- **Repeatable runs** write structured reports, SQLite state and artifacts under a known output root — ideal for CI, dashboards and agent loops.. You can also **repeat a run from any phase**, further saving time and costs.
- **Local-first verification** keeps sensitive URLs, traces, and artifacts on your machine while still using an LLM where judgment helps (planning, interpretation). Optional **remote** LLMs use your API key and base URL (see `docs/USAGE.md` and `checkirai.config.json`) - but the main idea is still to be able to run this locally.
- **CLI and MCP as the integration surface** lets Cursor, Claude Code and other hosts treat verification as a first-class tool alongside Chrome DevTools, filesystem, etc.

Note that doing the same task (spec-based software verification using tools) with a remote agent is almost certainly going to be faster, but **each and every run incurrs a cost local checks don't**. Plus, unlike with a remote agent, you only need to do the spec -> IR -> executive plan pipeline once: the local artifacts allow you to re-run the judgement/verification phase solely, further conserving resources.

---

## Use cases

- **Agent implement → verify → fix:** After a coding agent changes an app, call `verify` (or the MCP `verify_spec` tool) and feed failures back into the next edit.
- **Human acceptance checks:** Maintain a markdown spec next to the repo; run verification before merge or release.
- **Exploratory “what would we test?”:** Use `suggest_probe_plan` over MCP to plan probes without executing a full run.
- **Local model hygiene:** Use `ollama status`, `model list`, `model suggest`, and `model pull` so the right instruct/tool-capable model is available before a run.
- **Chrome DevTools MCP wiring:** Use `chrome-devtools list-tools` / `self-check` to confirm your MCP server exposes the expected tool surface (see `checkirai.config.json` for project defaults).
- **Dart/Flutter MCP wiring:** Use `dart-mcp list-tools` / `self-check` and the `fixtures/flutter_app` + `fixtures/flutter-spec.md` showcase for `run_tests` and driver-style verification.

---

## Requirements

- **Node.js** 22 or newer (`engines` in `package.json`)
- **pnpm** (recommended; scripts assume it)
- **Ollama** (optional but default for LLM-assisted phases) — install separately and start the daemon

---

## Installation

### 1. Clone and install dependencies

```bash
git clone https://github.com/globulus/checkirai
cd checkirai
pnpm install
```

`postinstall` runs a TypeScript build so the `checkirai` bin can load `dist/`.

### 2. Make the CLI available globally (pick one)

From the repo root:

```bash
pnpm link --global
```

Or install this package globally:

```bash
pnpm add -g .
```

Confirm the binary is on your `PATH` (pnpm’s global bin):

```bash
pnpm bin -g
checkirai --help
```

**Note:** The published entrypoint is `bin/checkirai.js` and delegates to `dist/`. If you see a build error, run `pnpm build` manually.

### 3. Optional project config

Copy or edit `checkirai.config.json` (or `.checkirai/config.json`) in your project root for:

- **`defaults`** — `targetUrl`, `tools`, `outRoot`, optional **`profile`** (selects a key from **`profiles`** for LLM overrides), plus runtime tuning: `maxRunMs`, `runCommandAllowlist` (prefix with `*` or full command line; **empty means no `run_command` runs**), **`allowShellMetacharacters`** (opt-in to shell metacharacters in allowlisted commands), `stepRetries`, `stepRetryDelayMs`, `isolateProbeSessions` (one session per probe), `artifactMaxRuns` (prune old per-run artifact folders).
- **`llm`** — Shared: **`ollamaHost`**, **`allowAutoPull`**, **`requireToolCapable`**. Per role **`normalizer`**, **`plannerAssist`**, **`judge`**, **`triage`**: each has **`provider`** (`ollama` \| `remote` \| `none`), **`model`**, optional **`fallbackModel`**, **`temperature`**, **`maxRetries`**, **`timeoutMs`**, and when **`remote`**: **`remoteBaseUrl`**, **`remoteApiKey`**. There is no single global `ollamaModel: "auto"`; each role names an explicit model tag (defaults ship in `src/llm/types.ts` and the sample config).
- **`profiles`** — Optional map (e.g. `laptop_16gb`) of partial per-role overrides merged on top of **`llm`** when **`defaults.profile`** or **`CHECKIRAI_PROFILE`** is set.
- **`mcpServers`** — e.g. `chrome-devtools` or `dart-mcp` with `command` / `args` so **`checkirai verify`** can spawn the matching MCP server when `--tools` includes that integration token.

---

## Web dashboard

The repo ships a **local web UI** plus a small API so you can kick off runs, watch progress, and browse results without living only in the terminal. **`checkirai.config.json`** **`defaults`** (timeouts, `runCommandAllowlist`, retries, isolation, artifact pruning, `allowShellMetacharacters`) are merged server-side when the request omits them. The **LLM** tab edits the full **`LlmPolicy`** (per-role providers, models, fallbacks, temperatures, Ollama host, auto-pull, require-tool-capable) and sends that object on **`verify_spec`**; the API still **`mergeLlmPolicyWithProjectProfile`** with the file, so **`profiles`** / **`defaults.profile`** apply on top. The **General** tab lists verifier **capability** ids (what probes may use) alongside the comma-separated **`tools`** tokens (what integrations are enabled). The **`model_catalog`** API (and **Model catalog** in the UI) includes a **`hardware`** block: total system RAM from the **API host** (`os.totalmem()`), a suggested **`profiles.*`** key (`laptop_16gb` / `workstation_24gb` / `high_end_40gb` per the LLM implementation plan), a RAM-filtered recommended model list, and—when that profile exists in the project file—a merged **`previewLlmPolicy`** you can apply in the dashboard.

| Mode                        | Command          | Notes                                                                        |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| Development (API + Vite UI) | `pnpm web:dev`   | UI: `http://127.0.0.1:5173` · API health: `http://127.0.0.1:8787/api/health` |
| Production build            | `pnpm web:build` | Builds TypeScript + Vite static assets                                       |
| Production serve            | `pnpm web:start` | Serves built UI + API (`SERVE_STATIC_FROM=web/dist`)                         |

For day-to-day work, `pnpm web:dev` is the usual choice.

---

## CLI commands

Top-level program: **`checkirai`** (aliases in `package.json`: `spec-driven-verifier`, `verify-app` → same binary).

### `checkirai verify`

Verify a target URL against a markdown spec (or restart from a previous run).

| Option                                       | Description                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--spec <path>`                              | Path to spec markdown (required unless restarting from `spec_ir` / `llm_plan` with `--restart-run`)                                                                                                                                                                |
| `--target <url>`                             | Base URL of the app under test (**required**)                                                                                                                                                                                                                      |
| `--tools <list>`                             | Comma-separated: `playwright-mcp`, `shell`, `fs`, `http`, `chrome-devtools`, `dart-mcp` (default `fs,http`)                                                                                                                                                         |
| `--dart-project-root <uri>`                  | Dart/Flutter project root (`file:` URI or absolute path) when using `dart-mcp`                                                                                                                                                                                      |
| `--dart-driver-device <id>`                  | Optional device id for `launch_app` preflight (driver-style runs)                                                                                                                                                                                                   |
| `--out <dir>`                                | Output root (default `.verifier`)                                                                                                                                                                                                                                  |
| `--policy <name>`                            | `read_only` or `ui_only`                                                                                                                                                                                                                                           |
| `--llm-provider <p>`                         | `ollama`, `remote`, or `none` (default `ollama`). **`none`** turns off all four roles. **`remote`** is not fully selectable from flags alone—put per-role **`remote*`** fields in **`checkirai.config.json`**; the CLI does not pass API keys on the command line. |
| `--ollama-host <url>`                        | Ollama HTTP API base URL (default `http://127.0.0.1:11434`); merged into policy for Ollama roles.                                                                                                                                                                  |
| `--ollama-model <name>`                      | When set, overrides the **`model`** tag for **all** roles that use Ollama after config merge; omit to keep per-role models from **`checkirai.config.json`** / code defaults.                                                                                       |
| `--allow-auto-pull` / `--no-allow-auto-pull` | Allow pulling missing Ollama models                                                                                                                                                                                                                                |
| `--restart-from <phase>`                     | `start` · `spec_ir` · `llm_plan`                                                                                                                                                                                                                                   |
| `--restart-run <runId>`                      | Parent run UUID when restarting                                                                                                                                                                                                                                    |

**Exit codes:** `0` pass · `1` fail · `2` inconclusive · `3` blocked.

### `checkirai ollama status`

Check that Ollama is reachable.

| Option         | Default                  |
| -------------- | ------------------------ |
| `--host <url>` | `http://127.0.0.1:11434` |

### `checkirai model list`

List installed Ollama models.

| Option         | Default                  |
| -------------- | ------------------------ |
| `--host <url>` | `http://127.0.0.1:11434` |

### `checkirai model suggest`

Print recommended models (structured / tool-friendly output).

| Option                       | Default                                    |
| ---------------------------- | ------------------------------------------ |
| `--tooling` / `--no-tooling` | Prefer tooling-capable models (default on) |

### `checkirai model pull <modelName>`

Download a model via Ollama’s HTTP API (e.g. `llama3.1:8b-instruct`).

| Option         | Default                  |
| -------------- | ------------------------ |
| `--host <url>` | `http://127.0.0.1:11434` |

### `checkirai chrome-devtools list-tools`

Spawn a Chrome DevTools MCP server process and log the tools it exposes.

| Option            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `--command <cmd>` | **Required** — executable to launch the MCP server |
| `--args <args>`   | Space-separated arguments (optional)               |
| `--cwd <cwd>`     | Working directory (default: current directory)     |

### `checkirai chrome-devtools self-check`

Verify the Chrome DevTools MCP server exposes the expected tool surface.

| Option            | Description  |
| ----------------- | ------------ |
| `--command <cmd>` | **Required** |
| `--args <args>`   | Optional     |
| `--cwd <cwd>`     | Optional     |

### `checkirai dart-mcp list-tools`

Spawn the Dart/Flutter MCP server process and log the tools it exposes.

| Option            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `--command <cmd>` | **Required** — executable to launch the MCP server |
| `--args <args>`   | Space-separated arguments (optional)               |
| `--cwd <cwd>`     | Working directory (default: current directory)     |

### `checkirai dart-mcp self-check`

Verify the Dart MCP server exposes the expected tool surface.

| Option            | Description  |
| ----------------- | ------------ |
| `--command <cmd>` | **Required** |
| `--args <args>`   | Optional     |
| `--cwd <cwd>`     | Optional     |

---

## MCP server and Cursor

Checkir AI exposes an **MCP server** (stdio) so editors and agents can call verification as tools instead of shelling out.

- **Implementation:** `src/interfaces/mcp/server.ts` (`startMcpServer()`)
- **Tools:** verification (`verify_spec`, `restart_verify_spec`, `suggest_probe_plan`, `list_capabilities`), run inspection (`get_report`, `get_run_graph`, `get_artifact`, `explain_failure`), and Ollama helpers (`ollama_status`, `model_list`, `model_suggest`, `model_pull`, `model_ensure`)

Start the server locally (stdio):

```bash
pnpm mcp
```

Optional: set `CHECKIRAI_OUT` to override the verifier output root (default `.verifier`).

**Cursor:** register the MCP server with **`node`** and an **absolute** path to **`dist/src/interfaces/mcp/bin.js`**, plus **`cwd`** on the clone root (built by `pnpm install` / `pnpm build`); or `pnpm --silent mcp`. Do **not** use plain `pnpm mcp` in the editor (script banner on stdout breaks MCP stdio). If `args` use a relative `dist/...` path and you see **`Cannot find module '/Users/…/dist/...'`** (home or wrong prefix), Cursor did not apply `cwd` to the child—switch the script path in `args` to an absolute path. If you use `--import tsx` and see **`ERR_MODULE_NOT_FOUND` for `tsx`**, fix `cwd` or install deps in that clone. See **[docs/USAGE.md](docs/USAGE.md)** for JSON snippets and `verify_spec` examples.

For end-to-end examples, probe output layout, and integration notes, **`docs/USAGE.md`** is the detailed guide.

---

## Development scripts

| Script                            | Purpose                       |
| --------------------------------- | ----------------------------- |
| `pnpm build`                      | Compile TypeScript to `dist/` |
| `pnpm dev`                        | Run CLI via tsx (`--help`)    |
| `pnpm typecheck`                  | `tsc --noEmit`                |
| `pnpm test`                       | Vitest                        |
| `pnpm lint` / `pnpm lint:fix`     | Biome                         |
| `pnpm format` / `pnpm format:fix` | Biome formatter               |
| `pnpm mcp`                        | MCP server (stdio)            |

---

## Architecture overview

End-to-end, a run is a **pipeline** from natural-language intent to a frozen result. An LLM (**Ollama** by default, or **`remote`**) is used where structure and judgment are needed; deterministic code handles orchestration, policies, and parts of scoring.

1. **Spec in** — Markdown file, **Spec bundle** (inline markdown + URLs + files resolved to text), or a pre-built **Spec IR** object.
2. **Normalize → Spec IR** — The configured LLM turns prose into a structured intermediate representation: requirements, observables, and metadata the rest of the system consumes. Outputs are **persisted** (e.g. `spec_ir` artifacts) so a run is auditable and replayable.
3. **Plan → test plan** — The planner consults the **capability graph** for your `--tools` set (HTTP, filesystem, shell, Playwright / Chrome DevTools MCP, …). Verifier **capabilities** (e.g. `navigate`, `read_ui_structure`, `run_command`, `call_http`) are the atomic actions probes may request; see **`src/capabilities/types.ts`** (`ALL_CAPABILITY_NAMES`). An LLM (and/or procedural planners) produces executable steps aligned with what is actually available.
4. **Execute** — The executor **bootstraps navigation** to the run’s target URL when Chrome + **`navigate`** are available (so snapshots are not taken against whatever tab was already open). Between probes it can **reset** to that URL again to shed UI mutations; optional **`isolateProbeSessions`** uses one session per probe. **`run_command`** is allowlist-gated (default deny if the list is empty) and rejects shell **metacharacters** unless **`defaults.allowShellMetacharacters`** is true. Optional **timeouts** and **step retries** cap hung or flaky work.
5. **Judge, triage & synthesize** — **Deterministic checks** (including more observable kinds, URL from the page, HTTP evidence where present) and **LLM judges** (per-role Ollama or **remote**) assign per-requirement verdicts (`pass` / `fail` / `inconclusive` / `blocked`). Optional **post-run triage** uses the **`triage`** role. Optional **`depends_on`** on a requirement blocks dependents when a prerequisite fails. The runtime emits `report.json`, `summary.md`, and related rows for the dashboard and MCP tools.

```mermaid
flowchart LR
  MD[Markdown or bundle] --> N[LLM to Spec IR]
  IR[Spec IR object] --> P[Plan using tools]
  N --> P
  P --> X[Execute tools]
  X --> J[Judge]
  J --> S[Report and summary]
```

### Starting from a checkpoint (“phases”)

You do **not** have to redo every expensive step. A parent run stores artifacts; a child run can **restart from a saved phase** by passing **`--restart-run`** with the parent’s run id and **`--restart-from`**:

| `--restart-from` | Meaning                                                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`start`**      | Full pipeline from spec input (default).                                                                                                                                                                                                                                                             |
| **`spec_ir`**    | Reuse the parent’s **frozen Spec IR**—skip normalization LLM work; continue with planning and later stages.                                                                                                                                                                                          |
| **`llm_plan`**   | Reuse the parent’s **saved test-plan artifact**—skip normalization and the main planning phase; continue with execution and judgement. Requires the same kind of setup as a full **MCP + LLM** generic loop (e.g. `chrome-devtools` or `dart-mcp` in `--tools` and an LLM provider other than `none`). |

The same **`restartFromPhase` / `restartFromRunId`** fields exist on **`verify_spec`** over MCP and on the web API; over MCP you can also call **`restart_verify_spec`** with **`parentRunId`** (and optional overrides). Pick the phase that matches how much of the parent run you want to reuse when iterating on plans, tooling, or judges.

---

## Status and contributing

This project is **work in progress**: behavior and APIs evolve **almost daily** as probes, judges and MCP integrations mature. If something is rough or undocumented, that is expected for now.

**Contributions are welcome** — issues, specs, probe ideas, and PRs that tighten verification or docs all help. For deeper context on the current MVP scope (including known limitations) read **[docs/USAGE.md](docs/USAGE.md)**.
