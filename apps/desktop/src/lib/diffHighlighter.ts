import type { HlNode } from "./highlightGrammars.ts";
import { splitHighlightedLines } from "./diffView.ts";

/**
 * Syntax highlighting for diffs, kept off the main thread so a big change scrolls smoothly:
 * a worker does the work, one file at a time. Where a worker can't start, files are
 * highlighted one per idle moment instead. Recent answers are kept, so scrolling back or
 * refreshing an unchanged file costs nothing.
 */

export interface HighlightedSides {
  old: HlNode[][] | null;
  new: HlNode[][] | null;
}

type Job = { id: number; old: string; new: string; lang: string; done: (r: HighlightedSides | null) => void };

const KEPT = 60;
const cache = new Map<string, HighlightedSides | null>();
const waiting = new Map<number, Job>();
let worker: Worker | null | undefined;
let nextId = 1;

function remember(key: string, value: HighlightedSides | null) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > KEPT) cache.delete(cache.keys().next().value!);
}

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./diffHighlight.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number } & HighlightedSides>) => {
      const job = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      job?.done({ old: e.data.old, new: e.data.new });
    };
    worker.onerror = () => {
      // The worker couldn't load: finish what it held on the main thread, and from now on too.
      worker?.terminate();
      worker = null;
      const jobs = [...waiting.values()];
      waiting.clear();
      for (const j of jobs) queueIdle(j);
    };
  } catch {
    worker = null;
  }
  return worker;
}

// ── The main-thread fallback: one file per idle moment ──
const idleQueue: Job[] = [];
let idleScheduled = false;
const whenIdle = (fn: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16));

function queueIdle(job: Job) {
  idleQueue.push(job);
  if (idleScheduled) return;
  idleScheduled = true;
  whenIdle(runIdle);
}

function runIdle() {
  idleScheduled = false;
  const job = idleQueue.shift();
  if (!job) return;
  void import("./highlightGrammars.ts").then(m => {
    const side = (text: string) => {
      const nodes = m.highlightCode(text, job.lang);
      return nodes ? splitHighlightedLines(nodes) : null;
    };
    job.done({ old: side(job.old), new: side(job.new) });
    if (idleQueue.length && !idleScheduled) {
      idleScheduled = true;
      whenIdle(runIdle);
    }
  });
}

/** Both sides highlighted line by line, or null for a language the highlighter doesn't know. */
export function highlightDiffSides(sides: { old: string; new: string }, lang: string): Promise<HighlightedSides | null> {
  const key = `${lang}\u0000${sides.old}\u0000${sides.new}`;
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    remember(key, hit);
    return Promise.resolve(hit);
  }
  return new Promise(resolve => {
    const job: Job = {
      id: nextId++,
      ...sides,
      lang,
      done: r => {
        const value = r && (r.old || r.new) ? r : null;
        remember(key, value);
        resolve(value);
      },
    };
    const w = startWorker();
    if (w) {
      waiting.set(job.id, job);
      w.postMessage({ id: job.id, old: job.old, new: job.new, lang });
    } else queueIdle(job);
  });
}
