export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file (context and removed lines). */
  oldNo: number | null;
  /** Line number in the new file (context and added lines). */
  newNo: number | null;
}

export interface ParsedDiff {
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Splits a unified diff into typed lines with old/new line numbers. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  const raw = diff.replace(/\r\n/g, "\n").split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  for (const text of raw) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk || text.startsWith("diff --git ")) {
      inHunk = false;
      lines.push({ kind: "meta", text, oldNo: null, newNo: null });
      continue;
    }
    if (text.startsWith("\\")) {
      lines.push({ kind: "note", text, oldNo: null, newNo: null });
    } else if (text.startsWith("+")) {
      additions += 1;
      lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
    } else if (text.startsWith("-")) {
      deletions += 1;
      lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
    } else {
      lines.push({ kind: "context", text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return { lines, additions, deletions };
}
