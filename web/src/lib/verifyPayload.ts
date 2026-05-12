export type McpServerFields = {
  command: string;
  args: string;
  cwd: string;
};

export type DartFields = {
  dartProjectRoot: string;
  dartDriverDevice: string;
};

export function buildMcpServerPayload(
  enabled: boolean,
  fields: McpServerFields,
): Record<string, unknown> {
  if (!enabled) return {};
  return {
    command: fields.command.trim(),
    ...(fields.args.trim()
      ? {
          args: fields.args
            .split(" ")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    ...(fields.cwd.trim() ? { cwd: fields.cwd.trim() } : {}),
  };
}

export function buildVerifyMcpExtras(options: {
  wantsChromeDevtools: boolean;
  chromeDevtools: McpServerFields;
  wantsDartMcp: boolean;
  dartMcp: McpServerFields;
  dart: DartFields;
}): Record<string, unknown> {
  const chrome = buildMcpServerPayload(
    options.wantsChromeDevtools,
    options.chromeDevtools,
  );
  const dart = buildMcpServerPayload(options.wantsDartMcp, options.dartMcp);
  return {
    ...(options.wantsChromeDevtools ? { chromeDevtoolsServer: chrome } : {}),
    ...(options.wantsDartMcp ? { dartMcpServer: dart } : {}),
    ...(options.dart.dartProjectRoot.trim()
      ? { dartProjectRoot: options.dart.dartProjectRoot.trim() }
      : {}),
    ...(options.dart.dartDriverDevice.trim()
      ? { dartDriverDevice: options.dart.dartDriverDevice.trim() }
      : {}),
  };
}
