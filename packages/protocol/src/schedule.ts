/**
 * Cron schedules for automations: five fields (minute hour day-of-month month day-of-week),
 * each `*`, a number, a range `1-5`, a list `1,15`, or a step `*\/15` / `9-17/2`. Day of week
 * is 0-6 from Sunday (7 is Sunday too). Like cron, when both day fields are set, either
 * matching is enough. Times are in an IANA time zone (default UTC).
 */

export interface Schedule {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const FIELDS: [name: string, min: number, max: number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
];

function field(text: string, [name, min, max]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`The ${name} part "${part}" isn't valid.`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === "*" ? min : Number(m[2]);
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to) throw new Error(`The ${name} part "${part}" is out of range (${min}-${max}).`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseSchedule(cron: string): Schedule {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule has five parts: minute hour day-of-month month day-of-week, e.g. 0 9 * * 1-5.");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]!));
  if (dow!.has(7)) {
    dow!.delete(7);
    dow!.add(0);
  }
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow!, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of `date` in `tz`. */
function local(date: Date, fmt: Intl.DateTimeFormat) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!);
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, dom: Number(p.day), month: Number(p.month), dow: weekday };
}

function matches(s: Schedule, t: ReturnType<typeof local>): boolean {
  if (!s.minute.has(t.minute) || !s.hour.has(t.hour) || !s.month.has(t.month)) return false;
  if (s.domAny && s.dowAny) return true;
  if (s.domAny) return s.dow.has(t.dow);
  if (s.dowAny) return s.dom.has(t.dom);
  return s.dom.has(t.dom) || s.dow.has(t.dow);
}

/** The first minute strictly after `after` that the schedule fires, or null within ~4 years. */
export function nextRun(cron: string | Schedule, after: Date, tz = "UTC"): Date | null {
  const s = typeof cron === "string" ? parseSchedule(cron) : cron;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  });
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 4 * 366 * 24 * 60 * 60_000;
  while (t < limit) {
    const d = new Date(t);
    const l = local(d, fmt);
    if (!s.month.has(l.month)) {
      t += 24 * 60 * 60_000 - (l.hour * 60 + l.minute) * 60_000; // skip to the next local day
      continue;
    }
    if (matches(s, l)) return d;
    // Not this hour: jump to its end. Otherwise, the next minute.
    t += s.hour.has(l.hour) ? 60_000 : (60 - l.minute) * 60_000;
  }
  return null;
}
