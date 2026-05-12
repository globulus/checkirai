import { DashboardLayout } from "./components/DashboardLayout";
import { DashboardProvider } from "./context/DashboardContext";

export function App() {
  return (
    <DashboardProvider>
      <DashboardLayout />
    </DashboardProvider>
  );
}
