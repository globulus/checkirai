# Usage Guide — Checkir AI

Checkir AI is a **spec-driven verification runtime**: you supply a spec and a target URL, and it returns requirement-level verdicts (`pass` / `fail` / `inconclusive` / `blocked`) backed by artifacts (JSON report, markdown summary, SQLite, on-disk evidence).

It runs as:

- **CLI** — `checkirai` for local runs and scripting  
- **MCP server (stdio)** — for Cursor and other hosts that speak the Model Context Protocol  
- **Web dashboard** — API + UI for interactive runs and progress  

Execution is **policy-gated** (e.g. read-only vs UI-oriented). LLM-assisted phases default to **Ollama** on your machine; you can switch to a **`remote`** OpenAI-compatible API via **`checkirai.config.json`** (see below). The pipeline is wired end-to-end (normalize → plan → execute → judge → synthesize). **`run_command`** is **allowlist-only** (empty list means shell steps never run). Some probes and browser automation paths are still evolving—treat edge verdicts and tooling as improving over time.

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

**`--tools`** is a comma-separated list. Supported tokens include: `fs`, `http`, `shell`, `playwright-mcp`, `chrome-devtools`. The CLI default is `fs,http`. The web dashboard may pick up `defaults.tools` from `checkirai.config.json` when you omit tools on a request (see below).

**Other useful `verify` flags:** `--policy read_only|ui_only`, `--llm-provider ollama|remote|none`, `--ollama-host`, `--ollama-model`, `--restart-from start|spec_ir|llm_plan` with `--restart-run <parentRunId>` to reuse artifacts from a previous run.

**Timeouts, retries, shell allowlist, probe isolation, artifact pruning:** set these under **`defaults`** in **`checkirai.config.json`** (or `.checkirai/config.json`)—they are merged for CLI, web API, and MCP runs (see **Project configuration**). There is no separate CLI flag for every knob yet.

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
| **`defaults`** | `targetUrl`, `tools`, `outRoot` (web API uses these when the request omits a field). Also: **`maxRunMs`** (overall cap), **`runCommandAllowlist`** (string prefixes or full command lines; use `"*"` only if you trust every probe; **omit or `[]` = no `run_command` execution**), **`stepRetries`** / **`stepRetryDelayMs`**, **`isolateProbeSessions`** (fresh browser session per probe when supported), **`artifactMaxRuns`** (keep only the newest N per-run artifact directories under `artifacts/`). |
| **`llm`** | `provider`: `ollama` \| `remote` \| `none`. Ollama: `ollamaHost`, `ollamaModel`, `allowAutoPull`, etc. **Remote:** `remoteBaseUrl`, `remoteApiKey`, `remoteModel` (OpenAI-compatible chat completions). Prefer env-backed secrets in your own deployment; the file is plain JSON. |
| **`mcpServers`** | e.g. `chrome-devtools` with `command` / `args` / `cwd` / `env` so **`checkirai verify`** can spawn Chrome DevTools MCP when `--tools` includes `chrome-devtools`. |

The CLI loads this file from the current working directory. The dashboard loads it for **merged defaults** and Chrome DevTools spawn configuration.

---

## Remote LLM example (`llm.provider: "remote"`)

```json
{
  "version": 1,
  "llm": {
    "provider": "remote",
    "remoteBaseUrl": "https://api.example.com/v1",
    "remoteApiKey": "sk-…",
    "remoteModel": "gpt-4.1-mini",
    "allowAutoPull": false
  },
  "defaults": {
    "maxRunMs": 900000,
    "runCommandAllowlist": ["pnpm test*", "npm run build"],
    "isolateProbeSessions": false
  }
}
```

Use **`--llm-provider remote`** on the CLI only together with this file; the CLI does not accept API keys on the command line.

---

## Spec IR: `depends_on`

When you pass structured **`spec`** (or restart from **`spec_ir`**), each requirement may include **`depends_on`**: an array of other requirement **`id`** strings that must **pass** before that requirement is judged. If a dependency fails or is blocked, dependents are marked **blocked** without re-running their probes. See `RequirementIRSchema` in **`src/spec/ir.ts`**.

---

## Web dashboard

Local UI + API for starting runs, streaming events, and browsing history.

**Merged behavior:** The API merges **`defaults`** from the project file into each **`verify_spec`** request (e.g. `tools`, `outDir`, timeouts, allowlist, retries, isolation, artifact pruning) when the JSON body omits those fields.

**LLM from the UI:** The form sends a full Ollama policy when **Ollama** is selected. For **`remote`** or **`none`**, the client currently sends only `{ "provider": "…" }`, which **replaces** the file’s `llm` object for that request—so **remote credentials in `checkirai.config.json` are not used** unless you extend the UI (or call the API without overriding `llm`). Practical options: keep **Ollama** in the dashboard and use **`remote`** from the CLI/MCP with a proper `llm` payload, or add form fields / merge logic in the web client later.

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
| `list_capabilities` | List capability classes for a comma-separated `tools` string (`fs`, `http`, `shell`, `playwright-mcp`, `chrome-devtools`, …) |

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
| `llm`                    | Full **`LlmPolicy`**: e.g. Ollama as below, or **`remote`** with `remoteBaseUrl`, `remoteApiKey`, `remoteModel` |
| `chromeDevtoolsServer`   | `{ "command": "...", "args": ["..."], "cwd": "..." }` to spawn Chrome DevTools MCP for this run (CLI can also read `checkirai.config.json`) |
| `restartFromPhase`       | `spec_ir` or `llm_plan` (not `start`) |
| `restartFromRunId`       | Parent run UUID when restarting |

**Merged from project `defaults` (not exposed as MCP `verify_spec` tool arguments today):** `maxRunMs`, `runCommandAllowlist`, `stepRetries`, `stepRetryDelayMs`, `isolateProbeSessions`, `artifactMaxRuns`. Put them in **`checkirai.config.json`** → **`defaults`** so CLI, web API, and MCP runs all pick them up. The **web** `/api/commands/verify_spec` body does not yet map these keys from JSON into `VerifySpecInput`; the shipped React UI has no fields for them—**file defaults are the supported path** for the dashboard.

For a focused restart call, **`restart_verify_spec`** accepts **`parentRunId`** (same UUID), **`restartFromPhase`** (`spec_ir` \| `llm_plan`), and optional overrides; see the tool description in the MCP host.

### Example: markdown

```json
{
  "targetUrl": "http://localhost:3000",
  "specMarkdown": "- Page shows a “Sign in” button\n- Clicking it opens a dialog",
  "tools": "fs,http",
  "llm": {
    "provider": "ollama",
    "ollamaHost": "http://127.0.0.1:11434",
    "ollamaModel": "auto",
    "allowAutoPull": true
  }
}
```

Remote policy shape (when not relying on `checkirai.config.json`):

```json
{
  "targetUrl": "http://localhost:3000",
  "specMarkdown": "- Page loads",
  "tools": "fs,http,chrome-devtools",
  "llm": {
    "provider": "remote",
    "remoteBaseUrl": "https://api.openai.com/v1",
    "remoteApiKey": "sk-…",
    "remoteModel": "gpt-4.1-mini"
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
  "llm": { "provider": "ollama", "ollamaModel": "auto", "allowAutoPull": true }
}
```

**Not in scope yet:** automatic fetch via arbitrary third-party MCPs (Figma, Linear, …) as first-class bundle kinds—HTTP and local file/markdown cover many cases; richer MCP “reader” adapters are future work.

---

## See also

- **[README.md](../README.md)** — overview, full CLI flag tables, dashboard summary.  
- For the fastest edit–verify loop in Cursor, register the MCP server as in **Cursor** above (`node dist/.../bin.js` or `pnpm --silent mcp`); use `pnpm mcp` only in a terminal where stdout is not the MCP transport.
