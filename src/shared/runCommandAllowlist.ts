const SHELL_METACHAR_RE = /[;&|`$(){}\[\]<>\r\n]/;

/** True if the fragment likely invokes shell parsing (metacharacters / newlines). */
export function hasShellMetacharacters(fragment: string): boolean {
  return SHELL_METACHAR_RE.test(fragment);
}

/**
 * Allowlist entries: exact match on the full command line (command + args, space-separated),
 * or prefix match when the entry ends with `*`.
 * Empty / missing allowlist denies all `run_command` invocations.
 */
export function isRunCommandAllowlisted(
  allowlist: string[] | undefined,
  command: string,
  args: string[],
): boolean {
  if (!allowlist?.length) return false;
  const cmdLine = [command.trim(), ...args.map((a) => String(a).trim())]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!cmdLine) return false;
  for (const raw of allowlist) {
    const p = raw.trim();
    if (!p) continue;
    if (p.endsWith("*")) {
      const pre = p.slice(0, -1);
      if (pre && cmdLine.startsWith(pre)) return true;
    } else if (cmdLine === p || command.trim() === p) {
      return true;
    }
  }
  return false;
}
