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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The shortest time allowed between two runs of a schedule, in minutes. */
export const SHORTEST_SCHEDULE_GAP_MINUTES = 5;

/**
 * The shortest time, in minutes, between two times of day the schedule fires at (counting
 * from the last one of a day round to the first of the next).
 */
export function shortestGapMinutes(cron: string | Schedule): number {
  const s = typeof cron === "string" ? parseSchedule(cron) : cron;
  const times = [...s.hour].flatMap(h => [...s.minute].map(m => h * 60 + m)).sort((a, b) => a - b);
  let shortest = times[0]! + 24 * 60 - times.at(-1)!;
  for (let i = 1; i < times.length; i++) shortest = Math.min(shortest, times[i]! - times[i - 1]!);
  return shortest;
}

function matchesDay(s: Schedule, d: { dom: number; month: number; dow: number }): boolean {
  if (!s.month.has(d.month)) return false;
  if (s.domAny && s.dowAny) return true;
  if (s.domAny) return s.dow.has(d.dow);
  if (s.dowAny) return s.dom.has(d.dom);
  return s.dom.has(d.dom) || s.dow.has(d.dow);
}

/**
 * Reads the clock on the wall in `tz` at a moment, and gives it back as the UTC time that
 * shows the same date and time. The difference between the two is the zone's offset.
 */
function wallClock(tz: string): (t: number) => number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  return t => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  };
}

/**
 * The first minute strictly after `after` that the schedule fires, or null within ~4 years.
 *
 * When the clocks change, a schedule for particular hours still fires once a day: a time
 * that comes round twice (clocks going back) fires the first time only, and a time that is
 * skipped (clocks going forward) fires at the first minute after the gap. A schedule for
 * every hour simply keeps going.
 */
export function nextRun(cron: string | Schedule, after: Date, tz = "UTC"): Date | null {
  const s = typeof cron === "string" ? parseSchedule(cron) : cron;
  const wall = wallClock(tz);
  const offsetAt = (t: number) => wall(t) - t;
  const first = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const hours = [...s.hour].sort((a, b) => a - b);
  const minutes = [...s.minute].sort((a, b) => a - b);
  const everyHour = hours.length === 24;

  // Walk the calendar in `tz` a day at a time (each day's midnight written as UTC), starting
  // a day early so a time skipped just before midnight is still made up.
  let offset = offsetAt(first);
  let day = Math.floor(wall(first) / DAY) * DAY - DAY;
  for (let i = 0; i <= 4 * 366 + 1; i++, day += DAY) {
    const date = new Date(day);
    if (!matchesDay(s, { dom: date.getUTCDate(), month: date.getUTCMonth() + 1, dow: date.getUTCDay() })) continue;

    // The zone's offset shortly before this day starts and shortly after it ends.
    const before = offsetAt(day - offset - 3 * HOUR);
    const later = offsetAt(day - offset + DAY + 3 * HOUR);
    offset = later;

    if (before === later) {
      // An ordinary day: every time on the clock happens exactly once, in order.
      for (const h of hours) {
        for (const m of minutes) {
          const t = day + (h * 60 + m) * MINUTE - before;
          if (t >= first) return new Date(t);
        }
      }
      continue;
    }

    // The clocks change on or next to this day: check each time on the clock by hand.
    let best: number | null = null;
    const consider = (t: number) => {
      if (t >= first && (best === null || t < best)) best = t;
    };
    let gapEnd: number | null = null;
    for (const h of hours) {
      for (const m of minutes) {
        const clock = day + (h * 60 + m) * MINUTE;
        const a = clock - before;
        const b = clock - later;
        const aHappens = wall(a) === clock;
        const bHappens = wall(b) === clock;
        if (aHappens && bHappens) {
          // This time comes round twice.
          consider(Math.min(a, b));
          if (everyHour) consider(Math.max(a, b));
        } else if (aHappens) consider(a);
        else if (bHappens) consider(b);
        else if (!everyHour) {
          // This time is skipped: the clocks jump over it somewhere between `b` and `a`.
          if (gapEnd === null) {
            let lo = b;
            let hi = a;
            while (hi - lo > MINUTE) {
              const mid = lo + Math.floor((hi - lo) / (2 * MINUTE)) * MINUTE;
              if (offsetAt(mid) === later) hi = mid;
              else lo = mid;
            }
            gapEnd = hi;
          }
          consider(gapEnd);
        }
      }
    }
    if (best !== null) return new Date(best);
  }
  return null;
}
