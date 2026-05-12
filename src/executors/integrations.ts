import type { ChromeDevtoolsMcpIntegration } from "../integrations/chromeDevtools/chromeDevtoolsMcpIntegration.js";
import type { DartMcpIntegration } from "../integrations/dart/dartMcpIntegration.js";
import type { FsIntegration } from "../integrations/fs/fsIntegration.js";
import type { HttpIntegration } from "../integrations/http/httpIntegration.js";
import type { ShellIntegration } from "../integrations/shell/shellIntegration.js";

export type ExecutorIntegrations = {
  fs?: FsIntegration;
  http?: HttpIntegration;
  shell?: ShellIntegration;
  chrome?: ChromeDevtoolsMcpIntegration;
  dart?: DartMcpIntegration;
};
