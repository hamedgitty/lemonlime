/** Longest single line we accept from an agent. Longer lines are dropped, not buffered. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Split a byte stream into lines without ever holding more than `maxBytes` of one line.
 * Node's readline buffers a line of any length, so an agent printing gigabytes without a
 * newline would take the runner down with it.
 */
export function lineSplitter(onLine: (line: string) => void, onOversize: (bytes: number) => void, maxBytes = MAX_LINE_BYTES) {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  let skipped = 0;

  const emit = () => {
    if (skipping) {
      onOversize(skipped);
    } else if (size > 0) {
      const line = Buffer.concat(parts, size).toString("utf8").replace(/\r$/, "");
      if (line.trim()) onLine(line);
    }
    parts = [];
    size = 0;
    skipping = false;
    skipped = 0;
  };

  return {
    write(chunk: Buffer): void {
      let start = 0;
      while (start < chunk.length) {
        const nl = chunk.indexOf(10, start);
        const end = nl === -1 ? chunk.length : nl;
        const piece = chunk.subarray(start, end);
        if (skipping) skipped += piece.length;
        else if (size + piece.length > maxBytes) {
          skipping = true;
          skipped = size + piece.length;
          parts = [];
          size = 0;
        } else if (piece.length) {
          parts.push(Buffer.from(piece));
          size += piece.length;
        }
        if (nl === -1) break;
        emit();
        start = nl + 1;
      }
    },
    /** Flush a last line that had no newline. */
    end(): void {
      if (size > 0 || skipping) emit();
    },
  };
}
