import { stripVTControlCharacters } from "node:util";

type ErrorCodeGrammar = { line: RegExp; allow: RegExp };

const grammars: Record<string, ErrorCodeGrammar> = {
  // npm error code E404 (npm <= 9: npm ERR! code E404)
  npm: {
    line: /^npm (?:error|ERR!) code (\S+)$/,
    allow: /^E[A-Z0-9_]{2,40}$/,
  },
  // [ERR_PNPM_FETCH_404] ... (pnpm <= 10 pads with thin spaces)
  pnpm: {
    line: /^(?:\[([A-Z0-9_]+)\] |\u2009([A-Z0-9_]+)\u2009 )/,
    allow: /^(?:ERR_PNPM_[A-Z0-9_]{1,60}|E[A-Z0-9_]{2,40})$/,
  },
  // ➤ YN0035: ...; YN0000 is the unnamed one
  yarn: {
    line: /^(?:➤ )?(YN\d{4}): /,
    allow: /^YN(?!0000)\d{4}$/,
  },
};

function getGrammar(command: string): ErrorCodeGrammar | undefined {
  const name = command
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
  return Object.hasOwn(grammars, name) ? grammars[name] : undefined;
}

// The result always matches the manager's allow-pattern, so it cannot carry free text.
export function getPackageManagerErrorCode(
  command: string,
  output: { stdout: string; stderr: string },
): string | undefined {
  const grammar = getGrammar(command);
  if (!grammar) return undefined;

  const lines = stripVTControlCharacters(`${output.stdout}\n${output.stderr}`).split(/\r?\n/);
  for (const line of lines.reverse()) {
    const match = grammar.line.exec(line);
    const candidate = match?.[1] ?? match?.[2];
    if (candidate !== undefined && grammar.allow.test(candidate)) return candidate;
  }
  return undefined;
}
