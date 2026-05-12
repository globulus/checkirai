import { useDashboard } from "../../context/DashboardContext";

export function ErrorBanner() {
  const { error } = useDashboard();
  if (!error) return null;

  return (
    <div className="card" style={{ borderColor: "#7f1d1d", marginBottom: 12 }}>
      <div style={{ fontWeight: 650, marginBottom: 8 }}>Error</div>
      <div className="mono">{error}</div>
    </div>
  );
}
