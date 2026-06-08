/**
 * Split a command-line-ish string into argv tokens. Supports:
 *   - unquoted whitespace separators
 *   - double-quoted strings with backslash escapes
 *   - single-quoted strings (no escapes, POSIX style)
 * Any dangling quote raises an error — it's safer to reject than to guess.
 */
export function tokenizeClaudeArgs(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    let token = "";
    let consumed = false;
    while (i < n) {
      const ch = input[i];
      if (ch === " " || ch === "\t" || ch === "\n") break;
      if (ch === '"') {
        i++;
        while (i < n && input[i] !== '"') {
          if (input[i] === "\\" && i + 1 < n) {
            token += input[i + 1];
            i += 2;
          } else {
            token += input[i];
            i++;
          }
        }
        if (i >= n) throw new Error("unclosed double quote");
        i++;
        consumed = true;
      } else if (ch === "'") {
        i++;
        while (i < n && input[i] !== "'") {
          token += input[i];
          i++;
        }
        if (i >= n) throw new Error("unclosed single quote");
        i++;
        consumed = true;
      } else if (ch === "\\" && i + 1 < n) {
        token += input[i + 1];
        i += 2;
        consumed = true;
      } else {
        token += ch;
        i++;
        consumed = true;
      }
    }
    if (consumed) out.push(token);
  }
  return out;
}
