import { useDashboard } from "../../context/DashboardContext";

export function SidebarTabs() {
  const { view, setView, wantsChromeDevtools, chromeDevtoolsCommand } =
    useDashboard();

  return (
    <div className="tabs" role="tablist" aria-label="Sidebar views">
      <button
        type="button"
        role="tab"
        aria-selected={view === "general"}
        className={`tab ${view === "general" ? "tabActive" : ""}`}
        onClick={() => setView("general")}
      >
        General
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "mcp"}
        className={`tab ${view === "mcp" ? "tabActive" : ""}`}
        onClick={() => setView("mcp")}
      >
        MCP
        {wantsChromeDevtools && !chromeDevtoolsCommand.trim() ? (
          <span className="tabDot" title="Needs setup" aria-hidden="true" />
        ) : null}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "llm"}
        className={`tab ${view === "llm" ? "tabActive" : ""}`}
        onClick={() => setView("llm")}
      >
        LLM
      </button>
    </div>
  );
}
