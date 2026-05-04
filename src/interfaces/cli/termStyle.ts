export type TermPalette = {
  reset: string;
  dim: string;
  bold: string;
  cyan: string;
  green: string;
  yellow: string;
  red: string;
  magenta: string;
  blue: string;
};

const plain: TermPalette = {
  reset: "",
  dim: "",
  bold: "",
  cyan: "",
  green: "",
  yellow: "",
  red: "",
  magenta: "",
  blue: "",
};

const ansi: TermPalette = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
  blue: "\u001b[34m",
};

export function createTermPalette(opts: { color: boolean }): TermPalette {
  if (!opts.color) return plain;
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "") return plain;
  if (!process.stdout.isTTY) return plain;
  return ansi;
}

export function verdictColor(
  t: TermPalette,
  verdict: string,
): { open: string; close: string } {
  switch (verdict) {
    case "pass":
      return { open: t.green + t.bold, close: t.reset };
    case "fail":
      return { open: t.red + t.bold, close: t.reset };
    case "inconclusive":
      return { open: t.yellow + t.bold, close: t.reset };
    case "blocked":
      return { open: t.magenta + t.bold, close: t.reset };
    case "cancelled":
      return { open: t.yellow + t.bold, close: t.reset };
    default:
      return { open: t.dim, close: t.reset };
  }
}
