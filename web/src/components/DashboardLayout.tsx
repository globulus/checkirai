import { useDashboard } from "../context/DashboardContext";
import { ErrorBanner } from "./run/ErrorBanner";
import { LlmActivityCard } from "./run/LlmActivityCard";
import { ModelCatalogCard } from "./run/ModelCatalogCard";
import { QuickActionsCard } from "./run/QuickActionsCard";
import { ResponseCard } from "./run/ResponseCard";
import { RestartRunCard } from "./run/RestartRunCard";
import { RunGraphCard } from "./run/RunGraphCard";
import { RunHeader } from "./run/RunHeader";
import { RunTimelineCard } from "./run/RunTimelineCard";
import { SpecIrCard } from "./run/SpecIrCard";
import { GeneralVerifyCard } from "./sidebar/GeneralVerifyCard";
import { LlmPolicyCard } from "./sidebar/LlmPolicyCard";
import { McpSettingsCard } from "./sidebar/McpSettingsCard";
import { RunsList } from "./sidebar/RunsList";
import { SidebarTabs } from "./sidebar/SidebarTabs";

export function DashboardLayout() {
  const { view } = useDashboard();

  return (
    <div className="layout">
      <div className="sidebar">
        <div className="h1">checkirai dashboard</div>
        <SidebarTabs />
        {view === "general" ? <GeneralVerifyCard /> : null}
        {view === "mcp" ? <McpSettingsCard /> : null}
        {view === "llm" ? <LlmPolicyCard /> : null}
        {view === "general" ? <RunsList /> : null}
      </div>

      <div className="main">
        <RunHeader />
        <ErrorBanner />
        <div className="split" style={{ marginBottom: 12 }}>
          <RunTimelineCard />
          <RunGraphCard />
        </div>
        <RestartRunCard />
        <SpecIrCard />
        <LlmActivityCard />
        <ResponseCard />
        <QuickActionsCard />
        <ModelCatalogCard />
      </div>
    </div>
  );
}
