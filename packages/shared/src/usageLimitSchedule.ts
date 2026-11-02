// @effect-diagnostics globalDate:off -- Calendar days in a named zone come from wall-clock epochs through Intl.
/**
 * When a subscription is meant to be used, so pace and forecasts count only
 * the time that matters. A schedule is weekdays, optional daily hours and an
 * optional time zone; without one every hour counts.
 * @module usageLimitSchedule
 */

/** ISO weekdays: 1 is Monday, 7 is Sunday. */
export type LimitWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const LIMIT_WEEKDAYS: readonly LimitWeekday[] = [1, 2, 3, 4, 5, 6, 7];

export interface LimitSchedule {
  readonly days: readonly LimitWeekday[];
  /** Minutes after local midnight, `0 <= start < end <= 1440`. Omitted: the whole day counts. */
  readonly hours?: { readonly start: number; readonly end: number } | undefined;
  /** IANA zone name. Omitted: this device's zone. */
  readonly timeZone?: string | undefined;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MINUTES_PER_DAY = 24 * 60;

export const EVERY_DAY: LimitSchedule = { days: LIMIT_WEEKDAYS };
export const WEEKDAYS: LimitSchedule = { days: [1, 2, 3, 4, 5] };
export const WORK_HOURS: LimitSchedule = {
  days: [1, 2, 3, 4, 5],
  hours: { start: 9 * 60, end: 17 * 60 },
};

export type LimitSchedulePreset = "everyDay" | "weekdays" | "workHours" | "custom";

function isEveryDay(schedule: LimitSchedule | undefined): boolean {
  return schedule === undefined || (schedule.days.length === 7 && schedule.hours === undefined);
}

export function limitSchedulePreset(schedule: LimitSchedule | undefined): LimitSchedulePreset {
  if (isEveryDay(schedule) && schedule?.timeZone === undefined) return "everyDay";
  if (schedule?.timeZone !== undefined) return "custom";
  const same = (candidate: LimitSchedule) =>
    schedule !== undefined &&
    candidate.days.join() === schedule.days.join() &&
    candidate.hours?.start === schedule.hours?.start &&
    candidate.hours?.end === schedule.hours?.end;
  if (same(WEEKDAYS)) return "weekdays";
  if (same(WORK_HOURS)) return "workHours";
  return "custom";
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    zoneFormat(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes a schedule from untrusted input (storage, a form): days deduplicated
 * and ordered, hours kept only when they form a real span, a zone kept only
 * when it exists. Returns undefined when no day is left, which has no use.
 */
export function normalizeLimitSchedule(value: unknown): LimitSchedule | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { days, hours, timeZone } = value as Record<string, unknown>;
  if (!Array.isArray(days)) return undefined;
  const kept = LIMIT_WEEKDAYS.filter((day) => days.includes(day));
  if (kept.length === 0) return undefined;
  const { start, end } =
    typeof hours === "object" && hours !== null ? (hours as Record<string, unknown>) : {};
  const validHours =
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    start < end &&
    end <= MINUTES_PER_DAY &&
    !(start === 0 && end === MINUTES_PER_DAY);
  const zone = typeof timeZone === "string" && isValidTimeZone(timeZone) ? timeZone : undefined;
  return {
    days: kept,
    ...(validHours ? { hours: { start, end } } : {}),
    ...(zone === undefined ? {} : { timeZone: zone }),
  };
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function clock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `Every day`, `Mon to Fri, 9:00 to 17:00`, `Mon, Wed, Fri (Europe/Berlin)`. */
export function describeLimitSchedule(schedule: LimitSchedule | undefined): string {
  if (schedule === undefined) return "Every day";
  const days = schedule.days;
  const run = days.every((day, index) => index === 0 || day === days[index - 1]! + 1);
  const dayText =
    days.length === 7
      ? "Every day"
      : run && days.length > 2
        ? `${DAY_NAMES[days[0]! - 1]} to ${DAY_NAMES[days.at(-1)! - 1]}`
        : days.map((day) => DAY_NAMES[day - 1]).join(", ");
  const hours = schedule.hours
    ? `, ${clock(schedule.hours.start)} to ${clock(schedule.hours.end)}`
    : "";
  return `${dayText}${hours}${schedule.timeZone ? ` (${schedule.timeZone})` : ""}`;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, format);
  }
  return format;
}

/** This device's zone, or UTC where the runtime cannot say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function resolveTimeZone(schedule: LimitSchedule | undefined): string {
  const zone = schedule?.timeZone;
  return zone !== undefined && isValidTimeZone(zone) ? zone : deviceTimeZone();
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minutes: number;
  readonly seconds: number;
}

function zonedParts(timeZone: string, at: number): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of zoneFormat(timeZone).formatToParts(new Date(at))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    minutes: ((values.hour ?? 0) % 24) * 60 + (values.minute ?? 0),
    seconds: values.second ?? 0,
  };
}

function zoneOffset(timeZone: string, at: number): number {
  const parts = zonedParts(timeZone, at);
  const local =
    Date.UTC(parts.year, parts.month - 1, parts.day) +
    parts.minutes * MINUTE +
    parts.seconds * 1000;
  return local - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a wall clock reads `minutes` after midnight on a calendar day in
 * `timeZone`. A time skipped by a clock change lands just after the change,
 * and one that happens twice takes the first.
 */
function zonedInstant(timeZone: string, date: Date, minutes: number): number {
  const local = date.getTime() + minutes * MINUTE;
  const guess = local - zoneOffset(timeZone, local);
  const offset = zoneOffset(timeZone, guess);
  if (guess + offset === local) return guess;
  const corrected = local - offset;
  const second = zoneOffset(timeZone, corrected);
  return second === offset ? corrected : local - Math.min(offset, second);
}

const calendarDay = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

const isoWeekday = (date: Date): LimitWeekday => (date.getUTCDay() || 7) as LimitWeekday;

/** `2026-11-02`: the calendar day of an instant in the schedule's zone. */
export function limitDayKey(schedule: LimitSchedule | undefined, at: number): string {
  const { year, month, day } = zonedParts(resolveTimeZone(schedule), at);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The weekday of an instant in the schedule's zone. */
export function limitWeekdayAt(schedule: LimitSchedule | undefined, at: number): LimitWeekday {
  const { year, month, day } = zonedParts(resolveTimeZone(schedule), at);
  return isoWeekday(calendarDay(year, month, day));
}

/** True when `at` falls on a counted day and, if hours are set, inside them. */
export function isLimitActiveAt(schedule: LimitSchedule | undefined, at: number): boolean {
  if (isEveryDay(schedule)) return true;
  const { year, month, day, minutes } = zonedParts(resolveTimeZone(schedule), at);
  if (!schedule!.days.includes(isoWeekday(calendarDay(year, month, day)))) return false;
  const hours = schedule!.hours;
  return hours === undefined || (minutes >= hours.start && minutes < hours.end);
}

/** How long one counted day lasts: the daily hours, else a whole day. */
export function limitActiveDayMs(schedule: LimitSchedule | undefined): number {
  return schedule?.hours ? (schedule.hours.end - schedule.hours.start) * MINUTE : DAY;
}

export interface ActiveTimeline {
  readonly start: number;
  readonly end: number;
  /** Mass over the whole window: milliseconds of counted time, or that scaled by day weights. */
  readonly total: number;
  /** Mass accumulated by `at`, which is clamped into the window. */
  massBefore: (at: number) => number;
  /** The instant by which `mass` has accumulated; `end` when the window holds less. */
  timeAtMass: (mass: number) => number;
  /** Where the mass curve bends, ends included; flat between a stretch's end and the next start. */
  readonly breakpoints: ReadonlyArray<{ readonly at: number; readonly mass: number }>;
}

interface Stretch {
  readonly from: number;
  readonly to: number;
  readonly mass: number;
}

/** Joins stretches that meet and gain mass at the same rate, which a chart need not bend at. */
function joined(stretches: readonly Stretch[]): readonly Stretch[] {
  const result: Stretch[] = [];
  for (const stretch of stretches) {
    const last = result.at(-1);
    const rate = (candidate: Stretch) => candidate.mass / (candidate.to - candidate.from);
    if (last && last.to === stretch.from && Math.abs(rate(last) - rate(stretch)) < 1e-12) {
      result[result.length - 1] = {
        from: last.from,
        to: stretch.to,
        mass: last.mass + stretch.mass,
      };
    } else {
      result.push(stretch);
    }
  }
  return result;
}

function timelineOf(start: number, end: number, parts: readonly Stretch[]): ActiveTimeline {
  const stretches = joined(parts);
  const breakpoints: Array<{ at: number; mass: number }> = [{ at: start, mass: 0 }];
  let total = 0;
  for (const stretch of stretches) {
    const last = breakpoints.at(-1)!;
    if (stretch.from > last.at) breakpoints.push({ at: stretch.from, mass: total });
    total += stretch.mass;
    breakpoints.push({ at: stretch.to, mass: total });
  }
  if (breakpoints.at(-1)!.at < end) breakpoints.push({ at: end, mass: total });
  return {
    start,
    end,
    total,
    breakpoints,
    massBefore(at) {
      let sum = 0;
      for (const stretch of stretches) {
        if (at >= stretch.to) sum += stretch.mass;
        else {
          if (at > stretch.from) {
            sum += (stretch.mass * (at - stretch.from)) / (stretch.to - stretch.from);
          }
          break;
        }
      }
      return sum;
    },
    timeAtMass(mass) {
      if (mass <= 0) return start;
      let sum = 0;
      for (const stretch of stretches) {
        if (sum + stretch.mass >= mass) {
          return stretch.mass === 0
            ? stretch.from
            : stretch.from + ((mass - sum) / stretch.mass) * (stretch.to - stretch.from);
        }
        sum += stretch.mass;
      }
      return end;
    },
  };
}

/** Longest window worth walking day by day; beyond it every hour is counted. */
const MAX_WALKED_DAYS = 400;

function buildTimeline(
  schedule: LimitSchedule | undefined,
  start: number,
  end: number,
  dayWeight?: (weekday: LimitWeekday) => number,
): ActiveTimeline {
  if (!(end > start)) return timelineOf(start, start, []);
  if (isEveryDay(schedule) && dayWeight === undefined) {
    return timelineOf(start, end, [{ from: start, to: end, mass: end - start }]);
  }
  const days = schedule?.days ?? LIMIT_WEEKDAYS;
  const hours = schedule?.hours;
  const zone = resolveTimeZone(schedule);
  if ((end - start) / DAY > MAX_WALKED_DAYS) {
    return timelineOf(start, end, [{ from: start, to: end, mass: end - start }]);
  }
  const first = zonedParts(zone, start);
  const stretches: Stretch[] = [];
  let date = calendarDay(first.year, first.month, first.day);
  for (let walked = 0; walked <= MAX_WALKED_DAYS; walked += 1) {
    const midnight = zonedInstant(zone, date, 0);
    if (midnight >= end) break;
    const next = new Date(date.getTime() + DAY);
    const weekday = isoWeekday(date);
    if (days.includes(weekday)) {
      const from = hours ? zonedInstant(zone, date, hours.start) : midnight;
      const to =
        hours && hours.end < MINUTES_PER_DAY
          ? zonedInstant(zone, date, hours.end)
          : zonedInstant(zone, next, 0);
      const length = to - from;
      const clippedFrom = Math.max(from, start);
      const clippedTo = Math.min(to, end);
      if (length > 0 && clippedTo > clippedFrom) {
        const clipped = clippedTo - clippedFrom;
        stretches.push({
          from: clippedFrom,
          to: clippedTo,
          mass: dayWeight ? (dayWeight(weekday) * clipped) / length : clipped,
        });
      }
    }
    date = next;
  }
  return timelineOf(start, end, stretches);
}

const cachedTimelines = new Map<string, ActiveTimeline>();
const MAX_CACHED_TIMELINES = 256;

/**
 * The counted time inside `[start, end)`. Without a schedule, or on one that
 * counts every hour, it is the whole window and costs nothing. `dayWeight`
 * scales a counted day's share, so a quiet weekday can weigh less than a busy
 * one; a day's weight is spread evenly over its counted hours.
 */
export function limitTimeline(
  schedule: LimitSchedule | undefined,
  start: number,
  end: number,
  dayWeight?: (weekday: LimitWeekday) => number,
): ActiveTimeline {
  if (dayWeight !== undefined) return buildTimeline(schedule, start, end, dayWeight);
  // Pace is asked for each bar on every render, and a walk costs a few formatter calls per day.
  const key = `${schedule?.days.join("")}|${schedule?.hours?.start}-${schedule?.hours?.end}|${schedule?.timeZone}|${start}|${end}`;
  let timeline = cachedTimelines.get(key);
  if (timeline === undefined) {
    if (cachedTimelines.size >= MAX_CACHED_TIMELINES) cachedTimelines.clear();
    timeline = buildTimeline(schedule, start, end);
    cachedTimelines.set(key, timeline);
  }
  return timeline;
}
