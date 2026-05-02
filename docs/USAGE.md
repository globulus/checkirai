# Usage Guide — Checkir AI

Checkir AI is a **spec-driven verification runtime**: you supply a spec and a target URL, and it returns requirement-level verdicts (`pass` / `fail` / `inconclusive` / `blocked`) backed by artifacts (JSON report, markdown summary, SQLite, on-disk evidence).

It runs as:

- **CLI** — `checkirai` for local runs and scripting  
- **MCP server (stdio)** — for Cursor and other hosts that speak the Model Context Protocol  
- **Web dashboard** — API + UI for interactive runs and progress  

Execution is **policy-gated** (e.g. read-only vs UI-oriented). LLM-assisted phases default to **Ollama** on your machine. The pipeline is wired end-to-end (normalize → plan → execute → judge → synthesize); some probes and browser automation paths are still evolving—treat edge verdicts and tooling as improving over time.

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

At the repo root (or `.checkirai/config.json`), you can set defaults and MCP subprocess definitions:

- **`defaults`** — e.g. `targetUrl`, `tools`, `outRoot` (used by the **web API** when fields are omitted)  
- **`llm`** — Ollama host, model, `allowAutoPull`, etc.  
- **`mcpServers`** — e.g. `chrome-devtools` with `command` / `args` so **`checkirai verify`** can spawn Chrome DevTools MCP when `--tools` includes `chrome-devtools`  

The CLI loads this file from the current working directory for Chrome DevTools integration; the dashboard loads it for defaults and server-side behavior.

---

## Web dashboard

Local UI + API for starting runs, streaming events, and browsing history.

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

### Recommended: `pnpm mcp`

```json
{
  "mcpServers": {
    "checkirai": {
      "command": "pnpm",
      "args": ["mcp"],
      "cwd": "/absolute/path/to/checkirai-repo"
    }
  }
}
```

Adjust `cwd` to your clone. Ensure `pnpm` is on the PATH Cursor uses.

### Alternative: direct `tsx` entry (no pnpm in PATH)

```json
{
  "mcpServers": {
    "checkirai": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/to/checkirai-repo/src/interfaces/mcp/bin.ts"],
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
4. Patch and rerun **`verify_spec`**.  

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
| `llm`                    | e.g. `{ "provider": "ollama", "ollamaHost": "http://127.0.0.1:11434", "ollamaModel": "auto", "allowAutoPull": true }` |
| `chromeDevtoolsServer`   | `{ "command": "...", "args": ["..."], "cwd": "..." }` to spawn Chrome DevTools MCP for this run (CLI can also read `checkirai.config.json`) |
| `restartFromPhase`       | `spec_ir` or `llm_plan` (not `start`) |
| `restartFromRunId`       | Parent run UUID when restarting |

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
- Run `pnpm mcp` and attach Cursor when you want the fastest edit–verify loop with local tools and models.
