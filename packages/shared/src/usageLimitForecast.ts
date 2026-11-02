/**
 * Where a limit window is heading: run rate, weekday pattern and recent trend,
 * the last two falling back to the run rate when what they need is missing.
 * @module usageLimitForecast
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import { type LimitInstance, RESET_TOLERANCE_MS } from "./usageLimitHistory.ts";
import { timedWindow, windowSpan } from "./usageLimitPace.ts";
import {
  type LimitSchedule,
  type LimitWeekday,
  LIMIT_WEEKDAYS,
  limitDayKey,
  limitTimeline,
} from "./usageLimitSchedule.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type ForecastAlgorithm = "runRate" | "weekday" | "trend";

export const FORECAST_ALGORITHMS: readonly ForecastAlgorithm[] = ["runRate", "weekday", "trend"];

/** Too little of a window has passed to say where it is heading. */
const MIN_ELAPSED_SHARE = 0.03;

/** The weekday pattern needs this many days between the first day with usage and today. */
const WEEKDAY_MIN_DAYS = 14;

/** Token totals older than this say little about the present. */
const WEEKDAY_LOOKBACK_DAYS = 90;

const TREND_HALF_LIFE_MS = 3 * DAY;
const TREND_LOOKBACK_MS = 14 * DAY;

/** The trend needs this much counted time between recorded readings. */
const TREND_MIN_COUNTED_MS = 12 * HOUR;

/** A day's token total for one provider, `day` being `YYYY-MM-DD` in the device's zone. */
export interface DailyTokens {
  readonly day: string;
  readonly tokens: number;
}

export interface ForecastPoint {
  readonly at: number;
  readonly usedPercent: number;
}

export interface Forecast {
  /** The estimate that produced these numbers; not the one asked for when that had to fall back. */
  readonly algorithm: ForecastAlgorithm;
  /** Spend at the reset, uncapped, so 130 means the window runs dry with 30 points of demand over. */
  readonly projectedUsedPercent: number;
  /** What is left unspent at the reset, 0 to 100. */
  readonly unusedPercent: number;
  /** When the window runs out, if it does before it resets. */
  readonly runsOutAt: number | null;
  /** From now to the reset, held at 100 once the window is spent. */
  readonly curve: readonly ForecastPoint[];
}

export type ForecastNote =
  | "weekdayNeedsTokens"
  | "weekdayTooEarly"
  | "trendNeedsReadings"
  | "tooEarly"
  | "noReset"
  | "outsideSchedule"
  | "ended";

export interface ForecastOutcome {
  readonly forecast: Forecast | null;
  /** Why the estimate asked for was not used, or why there is no forecast. */
  readonly note: ForecastNote | null;
}

export interface ForecastInput {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly schedule?: LimitSchedule | undefined;
  readonly algorithm: ForecastAlgorithm;
  /** Recorded instances of this window, oldest first. */
  readonly instances?: readonly LimitInstance[] | undefined;
  /** Daily token totals for this window's provider. */
  readonly dailyTokens?: readonly DailyTokens[] | undefined;
}

interface Shape {
  /** Mass accumulated by now and over the whole window. */
  readonly nowMass: number;
  readonly totalMass: number;
  /** Mass at each place the curve bends. */
  readonly breakpoints: ReadonlyArray<{ readonly at: number; readonly mass: number }>;
}

/**
 * Spend grows with the window's mass at `slope` points per unit from where it
 * stands now. The curve is clipped where it reaches 100.
 */
function project(
  used: number,
  now: number,
  shape: Shape,
  slope: number,
  algorithm: ForecastAlgorithm,
): Forecast {
  const spendAt = (mass: number) => used + slope * (mass - shape.nowMass);
  const curve: ForecastPoint[] = [{ at: now, usedPercent: Math.min(100, used) }];
  let runsOutAt: number | null = used >= 100 ? now : null;
  for (const point of shape.breakpoints) {
    if (point.at <= now) continue;
    const previous = curve.at(-1)!;
    const spend = spendAt(point.mass);
    if (runsOutAt !== null || spend <= 100) {
      curve.push({ at: point.at, usedPercent: Math.min(100, spend) });
      continue;
    }
    const crossing =
      previous.at +
      ((100 - previous.usedPercent) / (spend - previous.usedPercent)) * (point.at - previous.at);
    runsOutAt = crossing;
    curve.push({ at: crossing, usedPercent: 100 }, { at: point.at, usedPercent: 100 });
  }
  const projected = spendAt(shape.totalMass);
  return {
    algorithm,
    projectedUsedPercent: projected,
    unusedPercent: Math.max(0, Math.min(100, 100 - projected)),
    runsOutAt,
    curve,
  };
}

function runRate(
  window: ServerProviderUsageWindow,
  now: number,
  schedule: LimitSchedule | undefined,
): Forecast | "tooEarly" {
  const timed = timedWindow(window, schedule)!;
  const { timeline } = timed;
  const nowMass = timeline.massBefore(now);
  if (nowMass / timeline.total < MIN_ELAPSED_SHARE) return "tooEarly";
  const used = Math.max(0, Math.min(100, window.usedPercent));
  return project(
    used,
    now,
    { nowMass, totalMass: timeline.total, breakpoints: timeline.breakpoints },
    used / nowMass,
    "runRate",
  );
}

const dayNumber = (day: string) => {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date) / DAY;
};

/**
 * The mean tokens on each weekday over the days from the first one with usage
 * to today, a day without a record counting as a day of none. Null with less
 * than two weeks of that, or when the counted weekdays never saw any use.
 */
export function weekdayWeights(
  dailyTokens: readonly DailyTokens[],
  today: string,
  counted: readonly LimitWeekday[],
): Readonly<Record<LimitWeekday, number>> | null {
  const todayNumber = dayNumber(today);
  const recent = dailyTokens.filter((entry) => {
    const age = todayNumber - dayNumber(entry.day);
    return age >= 0 && age < WEEKDAY_LOOKBACK_DAYS && entry.tokens > 0;
  });
  if (recent.length === 0) return null;
  const first = Math.min(...recent.map((entry) => dayNumber(entry.day)));
  if (todayNumber - first + 1 < WEEKDAY_MIN_DAYS) return null;
  const sums = new Map<LimitWeekday, number>();
  const days = new Map<LimitWeekday, number>();
  // Day 0, 1 January 1970, was a Thursday.
  const weekdayOf = (number: number) => (((number + 3) % 7) + 1) as LimitWeekday;
  for (let day = first; day <= todayNumber; day += 1) {
    days.set(weekdayOf(day), (days.get(weekdayOf(day)) ?? 0) + 1);
  }
  for (const entry of recent) {
    const weekday = weekdayOf(dayNumber(entry.day));
    sums.set(weekday, (sums.get(weekday) ?? 0) + entry.tokens);
  }
  const weights = {} as Record<LimitWeekday, number>;
  for (const weekday of LIMIT_WEEKDAYS) {
    weights[weekday] = (sums.get(weekday) ?? 0) / Math.max(1, days.get(weekday) ?? 0);
  }
  return counted.some((weekday) => weights[weekday] > 0) ? weights : null;
}

function weekdayPattern(
  window: ServerProviderUsageWindow,
  now: number,
  schedule: LimitSchedule | undefined,
  dailyTokens: readonly DailyTokens[] | undefined,
): Forecast | "needsTokens" | "tooEarly" {
  const counted = schedule?.days ?? LIMIT_WEEKDAYS;
  const weights =
    dailyTokens === undefined
      ? null
      : weekdayWeights(dailyTokens, limitDayKey(schedule, now), counted);
  if (weights === null) return "needsTokens";
  const span = windowSpan(window)!;
  const timeline = limitTimeline(schedule, span.start, span.end, (weekday) => weights[weekday]);
  if (!(timeline.total > 0)) return "needsTokens";
  const nowMass = timeline.massBefore(now);
  if (nowMass / timeline.total < MIN_ELAPSED_SHARE) return "tooEarly";
  const used = Math.max(0, Math.min(100, window.usedPercent));
  return project(
    used,
    now,
    { nowMass, totalMass: timeline.total, breakpoints: timeline.breakpoints },
    used / nowMass,
    "weekday",
  );
}

/**
 * Points of the window spent per millisecond of counted time lately: each gap
 * between two recorded readings of one instance contributes its rise and its
 * counted time, weighted by how recent it is, halving every three days. Null
 * until the readings cover half a counted day.
 */
export function trendRate(
  instances: readonly LimitInstance[],
  now: number,
  schedule: LimitSchedule | undefined,
): number | null {
  const since = now - TREND_LOOKBACK_MS;
  const recent = instances.filter((instance) => instance.readings.some(([at]) => at >= since));
  const firstAt = Math.min(
    ...recent
      .flatMap((instance) => instance.readings.map(([at]) => at))
      .filter((at) => at >= since),
  );
  if (!Number.isFinite(firstAt) || firstAt >= now) return null;
  const counted = limitTimeline(schedule, firstAt, now);
  let rise = 0;
  let time = 0;
  let observed = 0;
  for (const instance of recent) {
    for (let index = 1; index < instance.readings.length; index += 1) {
      const [from, before] = instance.readings[index - 1]!;
      const [to, after] = instance.readings[index]!;
      if (from < since || to <= from || to > now) continue;
      const span = counted.massBefore(to) - counted.massBefore(from);
      if (span <= 0) continue;
      const weight = 0.5 ** ((now - to) / TREND_HALF_LIFE_MS);
      rise += weight * Math.max(0, after - before);
      time += weight * span;
      observed += span;
    }
  }
  return observed >= TREND_MIN_COUNTED_MS && time > 0 ? rise / time : null;
}

function recentTrend(
  window: ServerProviderUsageWindow,
  now: number,
  schedule: LimitSchedule | undefined,
  instances: readonly LimitInstance[] | undefined,
): Forecast | "needsReadings" {
  const rate = instances === undefined ? null : trendRate(instances, now, schedule);
  if (rate === null) return "needsReadings";
  const { timeline } = timedWindow(window, schedule)!;
  const used = Math.max(0, Math.min(100, window.usedPercent));
  return project(
    used,
    now,
    {
      nowMass: timeline.massBefore(now),
      totalMass: timeline.total,
      breakpoints: timeline.breakpoints,
    },
    rate,
    "trend",
  );
}

/**
 * The forecast for a window with the estimate asked for, or the run rate when
 * that estimate lacks what it needs (with the reason in `note`). No forecast
 * for a window with no reset, one that has reset, or one with under three
 * percent of its counted time behind it.
 */
export function forecastWindow(input: ForecastInput): ForecastOutcome {
  const { window, now, schedule, algorithm } = input;
  const timed = timedWindow(window, schedule);
  if (timed === null) {
    return { forecast: null, note: windowSpan(window) === null ? "noReset" : "outsideSchedule" };
  }
  if (timed.span.end <= now) return { forecast: null, note: "ended" };
  let note: ForecastNote | null = null;
  if (algorithm === "weekday") {
    const result = weekdayPattern(window, now, schedule, input.dailyTokens);
    if (typeof result !== "string") return { forecast: result, note: null };
    note = result === "needsTokens" ? "weekdayNeedsTokens" : "weekdayTooEarly";
  } else if (algorithm === "trend") {
    const result = recentTrend(window, now, schedule, input.instances);
    if (typeof result !== "string") return { forecast: result, note: null };
    note = "trendNeedsReadings";
  }
  const base = runRate(window, now, schedule);
  return base === "tooEarly" ? { forecast: null, note: "tooEarly" } : { forecast: base, note };
}

/**
 * One line on where the window is heading. `formatTime` writes an instant in
 * the viewer's zone and locale, which this module does not know.
 */
export function forecastSentence(forecast: Forecast, formatTime: (at: number) => string): string {
  if (forecast.runsOutAt !== null) return `On track to run out ${formatTime(forecast.runsOutAt)}`;
  const unused = Math.round(forecast.unusedPercent / 5) * 5;
  return unused >= 5 ? `On track to leave ~${unused}% unused` : "On track to use nearly all of it";
}

export interface BurnDownChart {
  readonly start: number;
  readonly end: number;
  /** Remaining allowance if spent evenly over the counted time; flat where nothing counts. */
  readonly ideal: ReadonlyArray<{ readonly at: number; readonly remainingPercent: number }>;
  readonly readings: ReadonlyArray<{ readonly at: number; readonly remainingPercent: number }>;
  readonly forecast: ReadonlyArray<{ readonly at: number; readonly remainingPercent: number }>;
}

/**
 * What the burn-down draws. Readings come from the recorded instance of this
 * window, if it is the one running, plus the reading in hand. Null for a
 * window with no span or nothing in it that counts.
 */
export function burnDownChart(input: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly checkedAt: number;
  readonly schedule?: LimitSchedule | undefined;
  readonly instance?: LimitInstance | null | undefined;
  readonly forecast?: Forecast | null | undefined;
}): BurnDownChart | null {
  const timed = timedWindow(input.window, input.schedule);
  if (timed === null) return null;
  const { span, timeline } = timed;
  const remaining = (usedPercent: number) => Math.max(0, 100 - usedPercent);
  const recorded =
    input.instance && Math.abs(input.instance.resetsAt - span.end) <= RESET_TOLERANCE_MS
      ? input.instance.readings
      : [];
  const live = Math.min(input.checkedAt, input.now);
  const readings = [
    ...recorded.filter(([at]) => at >= span.start && at < live),
    ...(live >= span.start && live < span.end ? ([[live, input.window.usedPercent]] as const) : []),
  ];
  return {
    start: span.start,
    end: span.end,
    ideal: timeline.breakpoints.map((point) => ({
      at: point.at,
      remainingPercent: 100 - (100 * point.mass) / timeline.total,
    })),
    readings: readings.map(([at, used]) => ({ at, remainingPercent: remaining(used) })),
    forecast: (input.forecast?.curve ?? []).map((point) => ({
      at: point.at,
      remainingPercent: remaining(point.usedPercent),
    })),
  };
}
