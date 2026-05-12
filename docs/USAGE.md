# Usage Guide — Checkir AI

Checkir AI is a **spec-driven verification runtime**: you supply a spec and a target URL, and it returns requirement-level verdicts (`pass` / `fail` / `inconclusive` / `blocked`) backed by artifacts (JSON report, markdown summary, SQLite, on-disk evidence).

It runs as:

- **CLI** — `checkirai` for local runs and scripting  
- **MCP server (stdio)** — for Cursor and other hosts that speak the Model Context Protocol  
- **Web dashboard** — API + UI for interactive runs and progress  

Execution is **policy-gated** (e.g. read-only vs UI-oriented). LLM-assisted phases use a **per-role** policy in **`checkirai.config.json`** (`normalizer`, `plannerAssist`, `judge`, `triage`): each role can be **Ollama**, **remote**, or **none**, with its own **`model`**, optional **`fallbackModel`**, **`temperature`**, **`maxRetries`**, and remote URL/key when applicable. Optional **`profiles`** plus **`defaults.profile`** (or **`CHECKIRAI_PROFILE`**) merge smaller models for constrained machines. The pipeline is wired end-to-end (normalize → plan → execute → judge → triage → synthesize). **`run_command`** is **allowlist-only** (empty list means shell steps never run) and blocks shell **metacharacters** unless **`defaults.allowShellMetacharacters`** is true. Some probes and browser automation paths are still evolving—treat edge verdicts and tooling as improving over time.

**Requirements:** Node.js **22+**, **pnpm**. Optional: Ollama, Playwright browsers if you use `playwright-mcp` in `--tools`.

---

## Quickstart (CLI)

### Install dependencies

```bash
pnpm install
```

`postinstall` runs `pnpm build` so the published `checkirai` bin can load `dist/`.

### Install the `checkirai` command (pick one)

From the repository root:

```bash
pnpm link --global
```

Or:

```bash
pnpm add -g .
```

If the command is not found, put pnpm’s global bin on your `PATH`:

```bash
pnpm bin -g
```

### Help and verify

```bash
checkirai --help
```

Create a spec (example `spec.md`):

```md
- The page has a “Sign in” button
- Submitting invalid credentials shows an error message
```

Run verification:

```bash
checkirai verify \
  --spec ./spec.md \
  --target http://localhost:3000 \
  --tools fs,http \
  --out .verifier
```

**`--tools`** is a comma-separated list of **integration** tokens (what to wire up): `fs`, `http`, `shell`, `playwright-mcp`, `chrome-devtools`, `dart-mcp`. The CLI default is `fs,http`. The web dashboard may pick up `defaults.tools` from `checkirai.config.json` when you omit tools on a request (see below).

Those tools map to a **capability graph** of verifier **capabilities**—the atomic actions probes may use—such as: **`navigate`**, **`read_ui_structure`**, **`read_visual`**, **`interact`**, **`read_console`**, **`read_network`**, **`read_files`**, **`run_command`**, **`call_http`**, **`query_data_store`**, **`read_source_code`**, **`read_design_reference`**, **`run_automated_tests`**, **`read_flutter_runtime`**. The canonical list is **`ALL_CAPABILITY_NAMES`** in **`src/capabilities/types.ts`**; MCP **`list_capabilities`** describes what is available for a given **`tools`** string.

**Other useful `verify` flags:** `--policy read_only|ui_only`, `--llm-provider ollama|none` (applies to all roles: **`none`** disables every role; **`ollama`** keeps per-role config from the file), `--ollama-host`, `--ollama-model` (when set, overrides **every** Ollama role’s **`model`** after merge—omit to keep per-role tags from config), `--restart-from start|spec_ir|llm_plan` with `--restart-run <parentRunId>` to reuse artifacts from a previous run.

**Timeouts, retries, shell allowlist, metacharacters opt-in, probe isolation, artifact pruning:** set these under **`defaults`** in **`checkirai.config.json`** (or `.checkirai/config.json`)—they are merged for CLI, web API, and MCP runs (see **Project configuration**). There is no separate CLI flag for every knob yet.

### Outputs

- SQLite: `<out>/verifier.sqlite`  
- Per run: `<out>/runs/<runId>/report.json`, `summary.md`  
- Evidence: `<out>/artifacts/<runId>/...`

### Exit codes

| Code | Meaning        |
| ---- | -------------- |
| `0`  | pass           |
| `1`  | fail           |
| `2`  | inconclusive   |
| `3`  | blocked        |

---

## Project configuration (`checkirai.config.json`)

At the repo root (or `.checkirai/config.json`), you can set defaults, LLM policy, and MCP subprocess definitions. The CLI, web API, and MCP server merge **`defaults`** and other relevant fields when starting a run.

| Section | Purpose |
| ------- | ------- |
| **`defaults`** | `targetUrl`, `tools`, `outRoot`, optional **`profile`** (key into **`profiles`** for LLM hardware overrides). Also: **`maxRunMs`**, **`runCommandAllowlist`**, **`allowShellMetacharacters`** (allow `;&|…` in allowlisted `run_command`—dangerous; default false), **`stepRetries`** / **`stepRetryDelayMs`**, **`isolateProbeSessions`**, **`artifactMaxRuns`**. |
| **`llm`** | Shared: **`ollamaHost`**, **`allowAutoPull`**, **`requireToolCapable`**. Per role **`normalizer`**, **`plannerAssist`**, **`judge`**, **`triage`**: **`provider`** (`ollama` \| `remote` \| `none`), **`model`**, optional **`fallbackModel`**, **`temperature`**, **`maxRetries`**, **`timeoutMs`**; for **`remote`**, **`remoteBaseUrl`** and **`remoteApiKey`** on that role. Prefer env-backed secrets in production; the file is plain JSON. |
| **`profiles`** | Optional object (e.g. `laptop_16gb`) whose values are partial **`llm`**-shaped patches (per-role fields only) merged when **`defaults.profile`** or **`CHECKIRAI_PROFILE`** matches the key. |
| **`mcpServers`** | e.g. `chrome-devtools` or `dart-mcp` with `command` / `args` / `cwd` / `env` so **`checkirai verify`** can spawn the matching MCP server when `--tools` includes that token. Optional **`defaults.dartProjectRoot`** (`file:` URI) for Flutter fixture runs. |

The CLI loads this file from the current working directory. The dashboard loads it for **merged defaults**, initial **LLM** form state, Chrome DevTools spawn configuration, and profile hints.

---

## Example: per-role Ollama + hardware profile

```json
{
  "version": 1,
  "defaults": {
    "targetUrl": "http://localhost:5173",
    "tools": "fs,http,chrome-devtools",
    "profile": "laptop_16gb"
  },
  "llm": {
    "ollamaHost": "http://127.0.0.1:11434",
    "allowAutoPull": true,
    "requireToolCapable": true,
    "normalizer": {
      "provider": "ollama",
      "model": "qwen2.5:14b-instruct",
      "fallbackModel": "qwen2.5:7b-instruct",
      "temperature": 0.1,
      "maxRetries": 3
    },
    "plannerAssist": {
      "provider": "ollama",
      "model": "qwen2.5:14b-instruct",
      "temperature": 0.2
    },
    "judge": {
      "provider": "ollama",
      "model": "deepseek-r1:14b",
      "fallbackModel": "qwen2.5:14b-instruct",
      "temperature": 0,
      "maxRetries": 2
    },
    "triage": {
      "provider": "ollama",
      "model": "deepseek-r1:14b",
      "temperature": 0.1
    }
  },
  "profiles": {
    "laptop_16gb": {
      "normalizer": { "model": "qwen2.5:7b-instruct" },
      "judge": {
        "model": "qwen2.5:14b-instruct",
        "fallbackModel": "qwen2.5:7b-instruct"
      }
    }
  }
}
```

## Example: remote on one role (e.g. judge only)

Set **`provider`** / **`remoteBaseUrl`** / **`remoteApiKey`** / **`model`** on **`judge`** (and keep other roles on Ollama or **`none`**). The CLI does not pass API keys on the command line—use the config file (or MCP **`verify_spec`** with a full **`llm`** JSON body).

---

## Spec IR: `depends_on`

When you pass structured **`spec`** (or restart from **`spec_ir`**), each requirement may include **`depends_on`**: an array of other requirement **`id`** strings that must **pass** before that requirement is judged. If a dependency fails or is blocked, dependents are marked **blocked** without re-running their probes. See `RequirementIRSchema` in **`src/spec/ir.ts`**.

---

## Web dashboard

Local UI + API for starting runs, streaming events, and browsing history.

**Merged behavior:** The API merges **`defaults`** from the project file into each **`verify_spec`** request (e.g. `tools`, `outDir`, timeouts, allowlist, retries, isolation, artifact pruning) when the JSON body omits those fields.

**LLM from the UI:** The **LLM** tab edits the full **`LlmPolicy`** (all four roles, shared Ollama host, auto-pull, require-tool-capable) and sends it as the **`llm`** property on **`verify_spec`**. The server parses it with **`LlmPolicySchema`** and then **`mergeLlmPolicyWithProjectProfile`**, so **`profiles`** / **`defaults.profile`** from the project file still apply on top. Run rows store a compact summary (`llm_provider`, `llm_model` pipe of role models).

**RAM-aware model hints:** The **`model_catalog`** command (and the dashboard refresh that calls it) returns **`hardware`**: total system RAM on the **machine running the API** (not the browser), a suggested hardware profile key aligned with **`checkirai.config.json` → `profiles`** (`laptop_16gb` below ~18 GiB, `workstation_24gb` below ~34 GiB, else `high_end_40gb`), a short rationale, a heuristic **`maxApproxQ4RamGiBForCatalog`** used to filter the downloadable **recommended** list, and **`previewLlmPolicy`** when the suggested profile exists in the project file. MCP **`model_suggest`** also returns **`hardware`** and **`modelsMatchingRam`**.

### Development (API + Vite)

```bash
pnpm web:dev
```

- UI: `http://127.0.0.1:5173`  
- API health: `http://127.0.0.1:8787/api/health`  

### Production build

```bash
pnpm web:build
pnpm web:start
```

The API honors env vars such as `PORT`, `HOST`, `OUT_ROOT`, and `SERVE_STATIC_FROM` (see `src/interfaces/web/bin.ts`).

---

## Ollama and local models (CLI)

```bash
checkirai ollama status --host http://127.0.0.1:11434
checkirai model list --host http://127.0.0.1:11434
checkirai model suggest --tooling
checkirai model pull llama3.1:8b-instruct --host http://127.0.0.1:11434
```

---

## Chrome DevTools MCP (CLI diagnostics)

Use these to confirm a Chrome DevTools MCP server process exposes tools Checkir AI expects:

```bash
checkirai chrome-devtools list-tools --command <cmd> [--args "..."] [--cwd <dir>]
checkirai chrome-devtools self-check --command <cmd> [--args "..."] [--cwd <dir>]
```

Point `--command` / `--args` at the same launch you configure under `mcpServers.chrome-devtools` in `checkirai.config.json` (for example `pnpm` + `exec chrome-devtools-mcp ...`).

---

## Dart/Flutter MCP (CLI diagnostics and fixture verify)

Register the Dart MCP server in Cursor (`mcp.json` key `dart` or `dart-mcp`) or under `mcpServers.dart-mcp` in `checkirai.config.json` (for example `dart mcp-server --experimental-mcp-server --force-roots-fallback`).

```bash
checkirai dart-mcp list-tools --command dart --args "mcp-server --experimental-mcp-server --force-roots-fallback"
checkirai dart-mcp self-check --command dart --args "mcp-server --experimental-mcp-server --force-roots-fallback"
```

Widget-test showcase (omit `http` so URL preflight is skipped; pass a `file:` project root):

```bash
checkirai verify \
  --spec fixtures/flutter-spec.md \
  --target file://fixture \
  --tools fs,dart-mcp \
  --dart-project-root "$(pwd)/fixtures/flutter_app"
```

Driver-style runs additionally need a device/emulator id via `--dart-driver-device` (or the dashboard MCP tab) so preflight can `launch_app` and connect DTD before `flutter_driver` steps.

---

## Recommended workflow (human or agent)

1. Implement or change the app.  
2. Run `checkirai verify` (or MCP `verify_spec`) against the spec.  
3. Open `report.json` / `summary.md` and artifact paths for failures.  
4. Fix and repeat.  

Verdicts prefer **`blocked`** / **`inconclusive`** over guessing a pass when evidence is insufficient.

---

## MCP server

Implementation: **`src/interfaces/mcp/server.ts`** (`startMcpServer()`). Transport: **stdio** (standard for Cursor and similar clients).

### Start the server (simplest)

From the **repository root**:

```bash
pnpm mcp
```

This runs `node --import tsx src/interfaces/mcp/bin.ts`. Optional environment:

| Variable        | Effect                                      |
| --------------- | ------------------------------------------- |
| `CHECKIRAI_OUT` | Default verifier output root (default `.verifier`) for tools that write under `outDir` |

### Tools exposed

**Verification**

| Tool                 | Purpose |
| -------------------- | ------- |
| `verify_spec`        | Full run: normalize/plan/execute/judge; returns structured verification result |
| `restart_verify_spec` | New run chained to a parent: `restartFromPhase` `spec_ir` or `llm_plan`, inherits `targetUrl` / default `llm` from parent when omitted (same engine as `verify_spec` + `restartFromRunId`) |
| `suggest_probe_plan` | Plan probes from `specMarkdown` or `spec` + tool set without executing |
| `list_capabilities` | For a comma-separated **`tools`** string, returns which verifier **capabilities** are available (e.g. `navigate`, `read_ui_structure`, `call_http`, …)—see **`src/capabilities/types.ts`** / **`ALL_CAPABILITY_NAMES`** |

**Run inspection** (after you have a `runId` from `verify_spec` or the dashboard)

| Tool              | Purpose |
| ----------------- | ------- |
| `get_report`      | Load stored JSON report by `runId` |
| `get_run_graph`   | Run graph: requirements, probes, tool calls, artifacts |
| `get_artifact`    | Artifact metadata / path by `runId` + `artifactId` |
| `explain_failure` | Short explanation for a failed/blocked requirement |

**Ollama / models**

| Tool            | Purpose |
| --------------- | ------- |
| `ollama_status` | Reachability + version |
| `model_list`    | Installed models |
| `model_suggest` | Recommended models (optional `requireTooling`) |
| `model_pull`    | Pull a model by name |
| `model_ensure`  | Ensure a usable model (may auto-pull per policy) |

---

## Cursor (and other MCP clients)

Register a **stdio** server whose working directory is this repo.

**Important:** MCP expects **only JSON-RPC on stdout**. Plain `pnpm mcp` is unsuitable in Cursor because pnpm prints the script banner to stdout before the server starts, which breaks the protocol (you may see `MCP error -32000: Connection closed`). Use one of the options below.

**`cwd`:** Set `cwd` to the **checkirai clone root** (absolute path). If Cursor opens another folder as the workspace, a missing or wrong `cwd` produces `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'` when using `--import tsx`, because `tsx` only exists under that repo’s `node_modules`.

**Relative `args` and Cursor:** Some hosts spawn the MCP process with a default working directory (for example your home folder) even when `cwd` is set in `mcp.json`. Then `node` looks for `dist/.../bin.js` under the wrong place (errors like `Cannot find module '/Users/you/dist/src/interfaces/mcp/bin.js'`). Use an **absolute path** to `bin.js` in `args` so the entry file is always found; keep `cwd` on the clone root for anything in the runtime that still uses `process.cwd()`.

### Recommended for Cursor: `node` on compiled output (no `tsx`)

After `pnpm install` in the clone, `postinstall` runs `pnpm build`, which emits `dist/src/interfaces/mcp/bin.js`. This avoids the `tsx` loader entirely.

```json
{
  "mcpServers": {
    "checkirai": {
      "command": "node",
      "args": ["/absolute/path/to/checkirai-repo/dist/src/interfaces/mcp/bin.js"],
      "cwd": "/absolute/path/to/checkirai-repo"
    }
  }
}
```

Use Node **22+** (see `engines` in `package.json`). If `dist/` is missing, run `pnpm build` in that repo (or reinstall without `--ignore-scripts`).

### Alternative: `node` + `tsx` (dev workflow; needs correct `cwd`)

```json
{
  "mcpServers": {
    "checkirai": {
      "command": "node",
      "args": ["--import", "tsx", "src/interfaces/mcp/bin.ts"],
      "cwd": "/absolute/path/to/checkirai-repo"
    }
  }
}
```

`cwd` must be the clone root so `node` can resolve the `tsx` package from `node_modules`.

### Alternative: `pnpm` with silent run (same script as `pnpm mcp`)

```json
{
  "mcpServers": {
    "checkirai": {
      "command": "pnpm",
      "args": ["--silent", "mcp"],
      "cwd": "/absolute/path/to/checkirai-repo"
    }
  }
}
```

`pnpm --silent` avoids printing the lifecycle script lines to stdout. Ensure `pnpm` is on the PATH Cursor uses.

### Alternative: `pnpm exec` (no script banner)

```json
{
  "mcpServers": {
    "checkirai": {
      "command": "pnpm",
      "args": ["exec", "node", "--import", "tsx", "src/interfaces/mcp/bin.ts"],
      "cwd": "/absolute/path/to/checkirai-repo"
    }
  }
}
```

After saving, reload MCP; tools such as `verify_spec` should appear for the agent.

### Agent loop

1. Implement changes.  
2. Call **`verify_spec`**.  
3. Use **`get_report`**, **`get_run_graph`**, **`explain_failure`**, or **`get_artifact`** as needed.  
4. To skip re-normalizing the spec or to replan after a tooling change, call **`restart_verify_spec`** with the prior **`runId`** as **`parentRunId`** and the right phase (`spec_ir` or `llm_plan`), or pass **`restartFromPhase`** / **`restartFromRunId`** on **`verify_spec`**.  
5. Patch and rerun **`verify_spec`** or **`restart_verify_spec`** as needed.  

---

## `verify_spec` inputs

Provide a **target URL** and exactly **one** primary spec shape (avoid combining multiple shapes in one call):

1. **`specMarkdown`** — single markdown string.  
2. **`spec`** — object validated as **Spec IR** (`src/spec/ir.ts`).  
3. **`specBundle`** — multi-input bundle (see below).  

Common optional fields:

| Field                    | Notes |
| ------------------------ | ----- |
| `targetUrl`              | Required base URL of the app under test |
| `tools`                  | Comma-separated tool set (default `fs,http`) |
| `outDir`                 | Output root (defaults to server’s root, usually `.verifier`) |
| `llm`                    | Full **`LlmPolicy`**: shared **`ollamaHost`**, **`allowAutoPull`**, **`requireToolCapable`**, plus per-role **`normalizer`**, **`plannerAssist`**, **`judge`**, **`triage`** (each: **`provider`**, **`model`**, optional **`fallbackModel`**, **`temperature`**, **`maxRetries`**, **`remoteBaseUrl`**, **`remoteApiKey`** when `provider` is **`remote`**) |
| `chromeDevtoolsServer`   | `{ "command": "...", "args": ["..."], "cwd": "..." }` to spawn Chrome DevTools MCP for this run (CLI can also read `checkirai.config.json`) |
| `restartFromPhase`       | `spec_ir` or `llm_plan` (not `start`) |
| `restartFromRunId`       | Parent run UUID when restarting |

**Merged from project `defaults` (omit on the request body to use file values):** `maxRunMs`, `runCommandAllowlist`, `allowShellMetacharacters`, `stepRetries`, `stepRetryDelayMs`, `isolateProbeSessions`, `artifactMaxRuns`, `profile`. Put them in **`checkirai.config.json`** → **`defaults`** so CLI, web API, and MCP runs pick them up. The shipped dashboard focuses on spec, **tools**, Chrome MCP launch, and **LLM** policy; other **`defaults`** knobs are file-driven unless you extend the client.

For a focused restart call, **`restart_verify_spec`** accepts **`parentRunId`** (same UUID), **`restartFromPhase`** (`spec_ir` \| `llm_plan`), and optional overrides; see the tool description in the MCP host.

### Example: markdown

```json
{
  "targetUrl": "http://localhost:3000",
  "specMarkdown": "- Page shows a “Sign in” button\n- Clicking it opens a dialog",
  "tools": "fs,http",
  "llm": {
    "ollamaHost": "http://127.0.0.1:11434",
    "allowAutoPull": true,
    "requireToolCapable": true,
    "normalizer": {
      "provider": "ollama",
      "model": "qwen2.5:14b-instruct",
      "fallbackModel": "qwen2.5:7b-instruct",
      "temperature": 0.1,
      "maxRetries": 3
    },
    "plannerAssist": {
      "provider": "ollama",
      "model": "qwen2.5:14b-instruct",
      "temperature": 0.2
    },
    "judge": {
      "provider": "ollama",
      "model": "deepseek-r1:14b",
      "fallbackModel": "qwen2.5:14b-instruct",
      "temperature": 0,
      "maxRetries": 2
    },
    "triage": {
      "provider": "ollama",
      "model": "deepseek-r1:14b",
      "temperature": 0.1
    }
  }
}
```

Remote example (judge only; other roles omitted here—merge with full defaults in real use):

```json
{
  "targetUrl": "http://localhost:3000",
  "specMarkdown": "- Page loads",
  "tools": "fs,http,chrome-devtools",
  "llm": {
    "ollamaHost": "http://127.0.0.1:11434",
    "allowAutoPull": true,
    "requireToolCapable": true,
    "normalizer": { "provider": "ollama", "model": "qwen2.5:14b-instruct", "temperature": 0.1 },
    "plannerAssist": { "provider": "ollama", "model": "qwen2.5:14b-instruct", "temperature": 0.2 },
    "judge": {
      "provider": "remote",
      "model": "gpt-4.1-mini",
      "remoteBaseUrl": "https://api.openai.com/v1",
      "remoteApiKey": "sk-…"
    },
    "triage": { "provider": "none", "model": "disabled" }
  }
}
```

### Spec bundles (multi-doc / URL / file)

**`specBundle`** is supported today. Schema: `src/spec/bundle.ts` (`SpecBundleSchema`).

- **`inputs`**: array of `{ "kind": "markdown" | "url" | "file", "ref": "...", "notes?": "..." }`  
  - `markdown`: `ref` is inline markdown.  
  - `url`: fetched via HTTP integration (must allow HTTP capability / policy).  
  - `file`: read via FS integration or local read.  
- **`run_goal`**: optional string.  
- **`allowedCapabilities`**: optional hint array.  

Inputs are resolved to one combined markdown string, then normalized to Spec IR with the LLM (same as a single markdown spec).

```json
{
  "targetUrl": "http://localhost:5173",
  "specBundle": {
    "run_goal": "Smoke acceptance",
    "inputs": [
      { "kind": "file", "ref": "./docs/product-spec.md" },
      { "kind": "url", "ref": "https://example.com/acceptance-notes.md" },
      { "kind": "markdown", "ref": "- Also: footer contains copyright" }
    ]
  },
  "tools": "fs,http",
  "llm": {
    "ollamaHost": "http://127.0.0.1:11434",
    "allowAutoPull": true,
    "requireToolCapable": true,
    "normalizer": { "provider": "ollama", "model": "qwen2.5:14b-instruct", "temperature": 0.1 },
    "plannerAssist": { "provider": "ollama", "model": "qwen2.5:14b-instruct", "temperature": 0.2 },
    "judge": { "provider": "ollama", "model": "deepseek-r1:14b", "temperature": 0 },
    "triage": { "provider": "ollama", "model": "deepseek-r1:14b", "temperature": 0.1 }
  }
}
```

**Not in scope yet:** automatic fetch via arbitrary third-party MCPs (Figma, Linear, …) as first-class bundle kinds—HTTP and local file/markdown cover many cases; richer MCP “reader” adapters are future work.

---

## See also

- **[README.md](../README.md)** — overview, full CLI flag tables, dashboard summary.  
- For the fastest edit–verify loop in Cursor, register the MCP server as in **Cursor** above (`node dist/.../bin.js` or `pnpm --silent mcp`); use `pnpm mcp` only in a terminal where stdout is not the MCP transport.
