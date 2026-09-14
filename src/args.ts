// --- Command-line token parsing ---
// Shared by /loop, /loop-patch and /loop-decompose so the dual flag forms
// (`--flag value` and `--flag=value`) are handled in exactly one place.

export interface TokenParseResult {
  /** Flags in the order first seen, with their values (undefined for bare flags). */
  flags: Map<string, string | undefined>;
  /** Non-flag tokens, in order. */
  positional: string[];
}

/**
 * Split a whitespace-separated arg string and classify tokens.
 * `--flag value` consumes the next token UNLESS the next token is itself a
 * flag — the bare-flag case (e.g. `--no-auto-approve spec.md`), where the
 * flag takes no value and the next token stays positional; `--flag=value`
 * takes the remainder verbatim (values may contain `=`); unknown `--*` tokens
 * are ignored.
 *
 * `bareFlags` are flags that NEVER consume a following token, even when it
 * is not itself a flag (e.g. `--no-auto-approve spec.md` → the flag is bare,
 * `spec.md` stays positional).
 */
export function parseTokens(args: string, bareFlags: ReadonlySet<string> = new Set()): TokenParseResult {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const flags = new Map<string, string | undefined>();
  const positional: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.startsWith("--")) {
      positional.push(part);
      continue;
    }
    const eq = part.indexOf("=");
    if (eq !== -1) {
      flags.set(part.slice(2, eq), part.slice(eq + 1));
      continue;
    }
    const name = part.slice(2);
    if (bareFlags.has(name)) {
      flags.set(name, undefined);
      continue;
    }
    if (i + 1 < parts.length && !parts[i + 1].startsWith("--")) {
      flags.set(name, parts[++i]);
    } else {
      flags.set(name, undefined);
    }
  }

  return { flags, positional };
}
