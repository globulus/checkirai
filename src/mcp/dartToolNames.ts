export const DART_MCP_TOOL_NAMES = new Set([
  "add_roots",
  "remove_roots",
  "create_project",
  "pub",
  "pub_dev_search",
  "analyze_files",
  "dart_format",
  "dart_fix",
  "run_tests",
  "hover",
  "signature_help",
  "resolve_workspace_symbol",
  "read_package_uris",
  "list_devices",
  "launch_app",
  "list_running_apps",
  "stop_app",
  "get_app_logs",
  "connect_dart_tooling_daemon",
  "get_runtime_errors",
  "hot_reload",
  "hot_restart",
  "get_active_location",
  "get_widget_tree",
  "get_selected_widget",
  "set_widget_selection_mode",
  "flutter_driver",
]);

export function isDartMcpToolName(tool: string): boolean {
  return DART_MCP_TOOL_NAMES.has(tool);
}
