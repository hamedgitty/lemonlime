/**
 * Splits a command line like `gemini --experimental-acp "my arg"` into words.
 * Supports single and double quotes and backslash escapes; no other shell syntax.
 */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** Joins words back into one command line, quoting words that need it. */
export function joinCommand(words: readonly string[]): string {
  return words.map(w => (w === "" ? '""' : /[\s"'\\]/.test(w) ? `"${w.replace(/(["\\])/g, "\\$1")}"` : w)).join(" ");
}
