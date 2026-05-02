import { describe, expect, it } from "vitest";
import { createShellIntegration } from "../src/integrations/shell/shellIntegration.js";

describe("shell integration policy", () => {
  it("blocks when allowCommands is empty", async () => {
    const shell = createShellIntegration({ allowCommands: [] });
    await expect(shell.run("echo", ["hi"])).rejects.toThrow();
  });
});
