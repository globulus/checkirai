import { useDashboard } from "../../context/DashboardContext";

export function McpSettingsCard() {
  const {
    wantsChromeDevtools,
    chromeDevtoolsCommand,
    setChromeDevtoolsCommand,
    chromeDevtoolsArgs,
    setChromeDevtoolsArgs,
    chromeDevtoolsCwd,
    setChromeDevtoolsCwd,
    wantsDartMcp,
    dartMcpCommand,
    setDartMcpCommand,
    dartMcpArgs,
    setDartMcpArgs,
    dartMcpCwd,
    setDartMcpCwd,
    dartProjectRoot,
    setDartProjectRoot,
    dartDriverDevice,
    setDartDriverDevice,
  } = useDashboard();

  return (
    <div className="card col" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 650 }}>MCP configuration</div>

      <div className="muted">
        Configure MCP servers for Chrome DevTools and Dart/Flutter when those
        tools are enabled in the verify form.
      </div>

      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="muted">Chrome DevTools MCP</div>
        {wantsChromeDevtools ? (
          <span className="badge">enabled</span>
        ) : (
          <span className="badge">disabled</span>
        )}
      </div>

      <label className="muted" htmlFor="chromeDevtoolsCommand">
        Command
      </label>
      <input
        id="chromeDevtoolsCommand"
        className="input"
        placeholder="e.g. node path/to/server.js  (whatever launches your MCP server)"
        value={chromeDevtoolsCommand}
        onChange={(e) => setChromeDevtoolsCommand(e.target.value)}
      />

      <label className="muted" htmlFor="chromeDevtoolsArgs">
        Args (space-separated)
      </label>
      <input
        id="chromeDevtoolsArgs"
        className="input"
        placeholder="(optional)"
        value={chromeDevtoolsArgs}
        onChange={(e) => setChromeDevtoolsArgs(e.target.value)}
      />

      <label className="muted" htmlFor="chromeDevtoolsCwd">
        Cwd
      </label>
      <input
        id="chromeDevtoolsCwd"
        className="input"
        placeholder="(optional)"
        value={chromeDevtoolsCwd}
        onChange={(e) => setChromeDevtoolsCwd(e.target.value)}
      />

      <div
        className="row"
        style={{ justifyContent: "space-between", marginTop: 12 }}
      >
        <div className="muted">Dart MCP</div>
        {wantsDartMcp ? (
          <span className="badge">enabled</span>
        ) : (
          <span className="badge">disabled</span>
        )}
      </div>

      <label className="muted" htmlFor="dartMcpCommand">
        Command
      </label>
      <input
        id="dartMcpCommand"
        className="input"
        placeholder="e.g. dart mcp-server --experimental-mcp-server --force-roots-fallback"
        value={dartMcpCommand}
        onChange={(e) => setDartMcpCommand(e.target.value)}
      />

      <label className="muted" htmlFor="dartMcpArgs">
        Args (space-separated)
      </label>
      <input
        id="dartMcpArgs"
        className="input"
        placeholder="(optional)"
        value={dartMcpArgs}
        onChange={(e) => setDartMcpArgs(e.target.value)}
      />

      <label className="muted" htmlFor="dartMcpCwd">
        Cwd
      </label>
      <input
        id="dartMcpCwd"
        className="input"
        placeholder="(optional)"
        value={dartMcpCwd}
        onChange={(e) => setDartMcpCwd(e.target.value)}
      />

      <label className="muted" htmlFor="dartProjectRoot">
        Dart project root (file: URI)
      </label>
      <input
        id="dartProjectRoot"
        className="input"
        placeholder="file:///absolute/path/to/fixtures/flutter_app"
        value={dartProjectRoot}
        onChange={(e) => setDartProjectRoot(e.target.value)}
      />

      <label className="muted" htmlFor="dartDriverDevice">
        Driver device id (optional)
      </label>
      <input
        id="dartDriverDevice"
        className="input"
        placeholder="(optional) launch_app preflight device id"
        value={dartDriverDevice}
        onChange={(e) => setDartDriverDevice(e.target.value)}
      />
    </div>
  );
}
