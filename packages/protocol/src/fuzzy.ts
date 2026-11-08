/**
 * Fuzzy matching shared by the runner (file search) and the apps (command palette,
 * composer menus). The letters of the query must appear in order; matches at the start
 * of a word, after a slash or in a run score higher, gaps score lower. Case is ignored.
 */

export interface FuzzyMatch {
  score: number;
  /** Indexes in the text of the letters that matched, for highlighting. */
  positions: number[];
}

const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const CONSECUTIVE = 1.0;
const BONUS_SLASH = 0.9;
const BONUS_WORD = 0.8;
const BONUS_CAPITAL = 0.7;
const BONUS_DOT = 0.6;
/** Texts longer than this are only checked as a subsequence, not scored letter by letter. */
const MAX_SCORED = 512;

function bonusAt(text: string, i: number): number {
  if (i === 0) return BONUS_WORD;
  const prev = text[i - 1]!;
  const ch = text[i]!;
  if (prev === "/" || prev === "\\") return BONUS_SLASH;
  if (prev === "-" || prev === "_" || prev === " " || prev === ":" || prev === ">") return BONUS_WORD;
  if (prev === ".") return BONUS_DOT;
  if (prev >= "a" && prev <= "z" && ch >= "A" && ch <= "Z") return BONUS_CAPITAL;
  return 0;
}

/** Null when the query's letters don't all appear in order. An empty query matches everything with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (n > m) return null;
  // Quick subsequence check first.
  for (let i = 0, j = 0; i < n; i++, j++) {
    j = t.indexOf(q[i]!, j);
    if (j < 0) return null;
  }
  if (n === m) return { score: Number.POSITIVE_INFINITY, positions: [...Array(n).keys()] };
  if (m > MAX_SCORED) {
    const positions: number[] = [];
    for (let i = 0, j = 0; i < n; i++, j++) positions.push((j = t.indexOf(q[i]!, j)));
    return { score: -m * 0.001, positions };
  }

  // D[i][j]: best score with q[i] matched exactly at t[j], ending a run there.
  // M[i][j]: best score for q[0..i] within t[0..j].
  const D: Float64Array[] = [];
  const M: Float64Array[] = [];
  const bonus = new Float64Array(m);
  for (let j = 0; j < m; j++) bonus[j] = bonusAt(text, j);
  for (let i = 0; i < n; i++) {
    const d = new Float64Array(m).fill(Number.NEGATIVE_INFINITY);
    const mm = new Float64Array(m).fill(Number.NEGATIVE_INFINITY);
    let prevScore = Number.NEGATIVE_INFINITY;
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
    for (let j = 0; j < m; j++) {
      if (q[i] === t[j]) {
        let score = Number.NEGATIVE_INFINITY;
        if (i === 0) score = j * GAP_LEADING + bonus[j]!;
        else if (j > 0) score = Math.max(M[i - 1]![j - 1]! + bonus[j]!, D[i - 1]![j - 1]! + CONSECUTIVE);
        d[j] = score;
        mm[j] = prevScore = Math.max(score, prevScore + gap);
      } else {
        d[j] = Number.NEGATIVE_INFINITY;
        mm[j] = prevScore = prevScore + gap;
      }
    }
    D.push(d);
    M.push(mm);
  }

  // Walk back to find where each letter matched.
  const positions: number[] = Array.from({ length: n }, () => 0);
  let matchRequired = false;
  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      if (D[i]![j] !== Number.NEGATIVE_INFINITY && (matchRequired || D[i]![j] === M[i]![j])) {
        matchRequired = i > 0 && j > 0 && M[i]![j] === D[i - 1]![j - 1]! + CONSECUTIVE;
        positions[i] = j--;
        break;
      }
    }
  }
  return { score: M[n - 1]![m - 1]!, positions };
}

/**
 * Like fuzzyMatch, for file paths: a match inside the file name beats the same match
 * spread over the folders, so `butt` finds `src/Button.tsx` before `src/but/test.ts`.
 */
export function fuzzyMatchPath(query: string, path: string): FuzzyMatch | null {
  const whole = fuzzyMatch(query, path);
  if (!whole) return null;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash < 0) return { ...whole, score: whole.score + 1 };
  const base = fuzzyMatch(query, path.slice(slash + 1));
  if (base && base.score + 1 >= whole.score) return { score: base.score + 1 - path.length * 0.0005, positions: base.positions.map(p => p + slash + 1) };
  return { ...whole, score: whole.score - path.length * 0.0005 };
}

export interface Ranked<T> {
  item: T;
  match: FuzzyMatch;
}

/** The items that match, best first (ties keep their order), at most `limit`. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string, opts: { limit?: number; paths?: boolean } = {}): Ranked<T>[] {
  const match = opts.paths ? fuzzyMatchPath : fuzzyMatch;
  const out: (Ranked<T> & { i: number })[] = [];
  items.forEach((item, i) => {
    const m = match(query, text(item));
    if (m) out.push({ item, match: m, i });
  });
  out.sort((a, b) => b.match.score - a.match.score || a.i - b.i);
  return (opts.limit !== undefined ? out.slice(0, opts.limit) : out).map(({ item, match }) => ({ item, match }));
}

/** Splits text into runs that matched and runs that didn't, for drawing highlights. */
export function highlightRuns(text: string, positions: readonly number[]): { text: string; hit: boolean }[] {
  if (positions.length === 0) return text ? [{ text, hit: false }] : [];
  const hits = new Set(positions);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i]!, hit });
  }
  return runs;
}
