import { highlightRuns } from "@lemonlime/protocol";

/** Text with the letters a fuzzy search matched drawn in bold green. */
export function Highlighted({ text, positions, offset = 0 }: { text: string; positions: readonly number[]; offset?: number }) {
  const shifted = offset ? positions.map(p => p - offset).filter(p => p >= 0 && p < text.length) : positions;
  return (
    <>
      {highlightRuns(text, shifted).map((r, i) =>
        r.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-leaf">
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}
