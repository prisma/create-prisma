import { stripVTControlCharacters } from "node:util";

type ErrorCodeGrammar = {
  /** Captures the identifier from one output line, anchored to where the manager prints it. */
  line: RegExp;
  /** The only values that may leave this module. */
  allow: RegExp;
};

// Only managers that print a stable, machine-readable identifier are listed.
// Bun, Deno and Yarn Classic report failures as prose, so they have no entry.
const grammars: Record<string, ErrorCodeGrammar> = {
  // npm >= 10 prints `npm error code E404`; older releases print `npm ERR! code E404`.
  // A failed lifecycle script reports its numeric exit status there, which is not an identifier.
  npm: {
    line: /^npm (?:error|ERR!) code (\S+)$/,
    allow: /^E[A-Z0-9_]{2,40}$/,
  },
  // pnpm >= 11 prints `[ERR_PNPM_FETCH_404] ...`; older releases pad the code with thin spaces.
  // Errors pnpm did not raise itself keep their own code, such as `ELIFECYCLE`.
  pnpm: {
    line: /^(?:\[([A-Z0-9_]+)\] |\u2009([A-Z0-9_]+)\u2009 )/,
    allow: /^(?:ERR_PNPM_[A-Z0-9_]{1,60}|E[A-Z0-9_]{2,40})$/,
  },
  // Yarn Berry prefixes every line with a message name; YN0000 is the unnamed one.
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

/**
 * Returns the package manager's own error identifier from captured command output.
 *
 * The result is either undefined or a value matching that manager's identifier
 * grammar, so it can never carry a path, package name, URL, or credential.
 * The last identifier wins because managers print the terminal error last.
 */
export function getPackageManagerErrorCode(
  command: string,
  output: { stdout: string; stderr: string },
): string | undefined {
  const grammar = getGrammar(command);
  if (!grammar) return undefined;

  // pnpm and Yarn report errors on stdout; npm reports them on stderr.
  const lines = stripVTControlCharacters(`${output.stdout}\n${output.stderr}`).split(/\r?\n/);
  for (const line of lines.reverse()) {
    const match = grammar.line.exec(line);
    const candidate = match?.[1] ?? match?.[2];
    if (candidate !== undefined && grammar.allow.test(candidate)) return candidate;
  }
  return undefined;
}
