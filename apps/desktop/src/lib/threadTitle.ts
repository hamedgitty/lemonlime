/**
 * Thread titles worked out on this computer from what the user wrote (no model is asked):
 * a short phrase from the first message, without the greetings and polite filler, and a
 * better one later when the first message said too little ("hi", "fix this").
 */

const MAX_WORDS = 6;
const MAX_CHARS = 60;

/** Openers that say nothing about the work. Longest first, so "hey there" goes before "hey". */
const LEADING_FILLER = [
  "i would like you to",
  "i'd like you to",
  "i want you to",
  "i need you to",
  "would you please",
  "could you please",
  "can you please",
  "will you please",
  "please could you",
  "please can you",
  "would you mind",
  "go ahead and",
  "i would like to",
  "i'd like to",
  "i want to",
  "i need to",
  "can you",
  "could you",
  "would you",
  "will you",
  "can we",
  "could we",
  "let's",
  "lets",
  "help me",
  "hey there",
  "hi there",
  "hello there",
  "good morning",
  "good afternoon",
  "hello",
  "hiya",
  "hey",
  "hi",
  "yo",
  "ok so",
  "okay so",
  "ok",
  "okay",
  "so",
  "um",
  "well",
  "please",
  "pls",
  "kindly",
  "just",
  "quickly",
];

const TRAILING_FILLER = ["please", "pls", "thanks", "thank you", "thx", "for me", "if you can", "if possible", "asap"];

/** Little words a cut-short title shouldn't end on. */
const DANGLING = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "that",
  "which",
  "when",
  "so",
  "as",
  "is",
  "my",
  "our",
  "your",
  "this",
  "it",
  "its",
  "if",
  "where",
  "how",
  "why",
  "what",
]);

/** Titles that say nothing about the work, as typed or after cleaning. */
const VAGUE = new Set([
  "",
  "hi",
  "hey",
  "hello",
  "yo",
  "help",
  "help me",
  "test",
  "testing",
  "fix",
  "fix this",
  "fix it",
  "fix that",
  "fix bug",
  "fix the bug",
  "bug",
  "continue",
  "go",
  "go on",
  "start",
  "begin",
  "do it",
  "do this",
  "do that",
  "keep going",
  "carry on",
  "try again",
  "again",
  "retry",
  "next",
  "yes",
  "no",
  "ok",
  "okay",
  "thanks",
  "thank you",
  "this",
  "that",
  "it",
  "question",
  "quick question",
  "a question",
  "look",
  "check",
  "check this",
  "look at this",
  "new thread",
  "thread",
  "untitled",
  "task",
  "work",
  "stuff",
  "something",
  "idea",
  "?",
]);

const lower = (s: string) => s.toLowerCase();

function stripLeading(s: string): string {
  let out = s;
  for (let changed = true; changed;) {
    changed = false;
    const l = lower(out);
    for (const f of LEADING_FILLER) {
      if (l === f || (l.startsWith(f) && /[\s,!.:;-]/.test(l[f.length] ?? ""))) {
        out = out.slice(f.length).replace(/^[\s,!.:;-]+/, "");
        changed = true;
        break;
      }
    }
  }
  return out;
}

function stripTrailing(s: string): string {
  let out = s.replace(/[\s?!.,:;…-]+$/, "");
  for (let changed = true; changed;) {
    changed = false;
    const l = lower(out);
    for (const f of TRAILING_FILLER) {
      if (l === f || (l.endsWith(f) && /[\s,]/.test(l[l.length - f.length - 1] ?? ""))) {
        out = out.slice(0, out.length - f.length).replace(/[\s?!.,:;…-]+$/, "");
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** The pieces of a message worth a title: sentences and lines, without code, quotes and markup. */
function candidates(prompt: string): string[] {
  const text = prompt
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/~~~[\s\S]*?(~~~|$)/g, "\n")
    .split("\n")
    .filter(line => !/^\s*>/.test(line))
    .join("\n")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`*_#]+/g, "")
    .replace(/(^|\s)@(\S)/g, "$1$2");
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9/])/)
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** A slash command at the start ("/review the auth code") gives way to what follows it. */
function dropCommand(s: string): string {
  const m = /^\/([\w:.-]+)\s*(.*)$/.exec(s);
  if (!m) return s;
  return m[2] ? m[2] : m[1]!.replace(/[-_:.]+/g, " ");
}

function shorten(s: string): string {
  const words = s.split(" ").filter(Boolean);
  if (words.length <= MAX_WORDS && s.length <= MAX_CHARS) return s;
  let cut = words.slice(0, MAX_WORDS);
  while (cut.length > 1 && cut.join(" ").length > MAX_CHARS) cut = cut.slice(0, -1);
  while (cut.length > 2 && DANGLING.has(lower(cut[cut.length - 1]!).replace(/[^\w']/g, ""))) cut = cut.slice(0, -1);
  const out = cut.join(" ").replace(/[,:;-]+$/, "");
  return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS - 1).trimEnd()}…` : out;
}

function cleanOne(s: string): string {
  const t = stripTrailing(stripLeading(dropCommand(s)));
  if (!t) return "";
  const short = shorten(t);
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** Whether a title tells you nothing about the thread ("Hi", "Fix this", "Continue"). */
export function isVagueTitle(title: string): boolean {
  const t = lower(title)
    .replace(/[\s?!.,:;…]+$/, "")
    .replace(/^[\s?!.,:;]+/, "")
    .trim();
  if (VAGUE.has(t)) return true;
  if (t.length < 3) return true;
  // One word that's a greeting or filler ("hiii", "heyy").
  return /^(h+i+|he+y+|hel+o+|ok+|thx|ty|yo+)$/.test(t);
}

/**
 * A thread's title from its first message: the first sentence that says something, without
 * greetings and polite filler, cut to about six words. Falls back to the first line.
 */
export function cleanTitle(prompt: string): string {
  const parts = candidates(prompt);
  let first = "";
  for (const p of parts) {
    const t = cleanOne(p);
    if (!t) continue;
    if (!first) first = t;
    if (!isVagueTitle(t)) return t;
  }
  if (first) return first;
  const line = legacyTitle(prompt);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The title the app used to give a thread: its first line, cut at 60 characters. */
export function legacyTitle(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > MAX_CHARS ? `${line.slice(0, MAX_CHARS - 1).trimEnd()}…` : line;
}

/**
 * A better title for a thread whose title is still the vague one made from its first
 * message, from the first later message that says more. Null to leave it alone (renamed by
 * hand, already clear, or nothing better yet).
 */
export function betterTitle(title: string, prompts: readonly string[]): string | null {
  const first = prompts[0];
  if (first === undefined || prompts.length < 2) return null;
  // Only titles the app made: one the user typed is theirs, however short.
  if (title !== cleanTitle(first) && title !== legacyTitle(first)) return null;
  if (!isVagueTitle(title)) return null;
  for (const p of prompts.slice(1)) {
    const t = cleanTitle(p);
    if (t && !isVagueTitle(t)) return t === title ? null : t;
  }
  return null;
}
