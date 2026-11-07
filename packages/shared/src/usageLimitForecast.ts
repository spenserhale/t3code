/**
 * Where a limit window is heading: run rate, weekday pattern and recent trend,
 * the last two falling back to the run rate when what they need is missing.
 * @module usageLimitForecast
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  type LimitHistory,
  type LimitInstance,
  type LimitReading,
  RESET_TOLERANCE_MS,
  limitSeriesKey,
  windowBaseline,
} from "./usageLimitHistory.ts";
import { type PaceDetail, type TimedWindow, timedWindow, windowSpan } from "./usageLimitPace.ts";
import {
  type ActiveTimeline,
  type LimitSchedule,
  type LimitWeekday,
  type WeekdayWeights,
  LIMIT_WEEKDAYS,
  limitDayKey,
  limitDaysBetween,
  limitTimeline,
} from "./usageLimitSchedule.ts";
import type { LimitAccount } from "./usageLimits.ts";

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

const shapeOf = (timeline: ActiveTimeline, now: number): Shape => ({
  nowMass: timeline.massBefore(now),
  totalMass: timeline.total,
  breakpoints: timeline.breakpoints,
});

const usedOf = (window: ServerProviderUsageWindow) =>
  Math.max(0, Math.min(100, window.usedPercent));

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
  baseline: LimitReading | undefined,
): Forecast | "tooEarly" {
  const { timeline, startUsed } = timedWindow(window, schedule, { baseline })!;
  const shape = shapeOf(timeline, now);
  if (shape.nowMass / timeline.total < MIN_ELAPSED_SHARE) return "tooEarly";
  const used = usedOf(window);
  return project(used, now, shape, Math.max(0, used - startUsed) / shape.nowMass, "runRate");
}

const dayNumber = (day: string) => {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date) / DAY;
};

/**
 * The mean tokens on each weekday over the whole days from the first one with
 * usage until yesterday, a day without a record counting as a day of none. Today
 * is left out, as its total is not in yet. Null with less than two weeks of
 * that, or when the counted weekdays never saw any use.
 */
export function weekdayWeights(
  dailyTokens: readonly DailyTokens[],
  today: string,
  counted: readonly LimitWeekday[],
): WeekdayWeights | null {
  const todayNumber = dayNumber(today);
  const recent = dailyTokens.filter((entry) => {
    const age = todayNumber - dayNumber(entry.day);
    return age >= 1 && age <= WEEKDAY_LOOKBACK_DAYS && entry.tokens > 0;
  });
  if (recent.length === 0) return null;
  const first = Math.min(...recent.map((entry) => dayNumber(entry.day)));
  if (todayNumber - first < WEEKDAY_MIN_DAYS) return null;
  const sums = new Map<LimitWeekday, number>();
  const days = new Map<LimitWeekday, number>();
  // Day 0, 1 January 1970, was a Thursday.
  const weekdayOf = (number: number) => (((number + 3) % 7) + 1) as LimitWeekday;
  for (let day = first; day < todayNumber; day += 1) {
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
  baseline: LimitReading | undefined,
): Forecast | "needsTokens" | "tooEarly" {
  const counted = schedule?.days ?? LIMIT_WEEKDAYS;
  const weights =
    dailyTokens === undefined
      ? null
      : weekdayWeights(dailyTokens, limitDayKey(schedule, now), counted);
  if (weights === null) return "needsTokens";
  const timed = timedWindow(window, schedule, { baseline, weights })!;
  if (timed.reference !== "pattern") return "needsTokens";
  const shape = shapeOf(timed.timeline, now);
  if (shape.nowMass / timed.timeline.total < MIN_ELAPSED_SHARE) return "tooEarly";
  const used = usedOf(window);
  return project(used, now, shape, Math.max(0, used - timed.startUsed) / shape.nowMass, "weekday");
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
  baseline: LimitReading | undefined,
): Forecast | "needsReadings" {
  const rate = instances === undefined ? null : trendRate(instances, now, schedule);
  if (rate === null) return "needsReadings";
  const { timeline } = timedWindow(window, schedule, { baseline })!;
  return project(usedOf(window), now, shapeOf(timeline, now), rate, "trend");
}

/**
 * The forecast for a window with the estimate asked for, or the run rate when
 * that estimate lacks what it needs (with the reason in `note`). No forecast
 * for a window with no reset, one that has reset, or one with under three
 * percent of its counted time behind it.
 */
export function forecastWindow(input: ForecastInput): ForecastOutcome {
  const { window, now, schedule, algorithm } = input;
  const span = windowSpan(window);
  if (span === null) return { forecast: null, note: "noReset" };
  // Spending is counted from a clearing if a reset credit emptied the window.
  const baseline = windowBaseline(input.instances, span.end);
  if (timedWindow(window, schedule, { baseline }) === null) {
    return { forecast: null, note: "outsideSchedule" };
  }
  if (span.end <= now) return { forecast: null, note: "ended" };
  let note: ForecastNote | null = null;
  if (algorithm === "weekday") {
    const result = weekdayPattern(window, now, schedule, input.dailyTokens, baseline);
    if (typeof result !== "string") return { forecast: result, note: null };
    note = result === "needsTokens" ? "weekdayNeedsTokens" : "weekdayTooEarly";
  } else if (algorithm === "trend") {
    const result = recentTrend(window, now, schedule, input.instances, baseline);
    if (typeof result !== "string") return { forecast: result, note: null };
    note = "trendNeedsReadings";
  }
  const base = runRate(window, now, schedule, baseline);
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

/**
 * What pace and the chart's reference line need beyond the schedule: where
 * spending is counted from if a reset credit cleared the window, and the usual
 * spend by weekday if the account's provider has enough token history.
 */
export function paceDetailFor(input: {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly schedule: LimitSchedule | undefined;
  readonly now: number;
  readonly history?: LimitHistory | undefined;
  readonly dailyTokens?:
    | ((account: LimitAccount) => readonly DailyTokens[] | undefined)
    | undefined;
}): PaceDetail {
  const { account, window, schedule, now } = input;
  const span = windowSpan(window);
  const tokens = input.dailyTokens?.(account);
  return {
    baseline:
      span === null
        ? undefined
        : windowBaseline(input.history?.[limitSeriesKey(account, window)], span.end),
    weights:
      tokens === undefined
        ? null
        : weekdayWeights(tokens, limitDayKey(schedule, now), schedule?.days ?? LIMIT_WEEKDAYS),
  };
}

export interface BurnDownChart {
  readonly start: number;
  readonly end: number;
  /** Whether the reference line is the usual weekday pattern or even spending over counted time. */
  readonly referenceKind: "pattern" | "even";
  /** What would be left if spending followed the reference line; flat where nothing counts. */
  readonly reference: ReadonlyArray<{ readonly at: number; readonly remainingPercent: number }>;
  readonly readings: ReadonlyArray<{ readonly at: number; readonly remainingPercent: number }>;
  readonly forecast: ReadonlyArray<{ readonly at: number; readonly remainingPercent: number }>;
}

interface ReadingsInput {
  readonly window: ServerProviderUsageWindow;
  /** When the reading in hand was taken. It is drawn there, never at the viewer's clock. */
  readonly checkedAt: number;
  readonly instance?: LimitInstance | null | undefined;
}

/**
 * The window's readings from where counting starts: those recorded for this
 * window, then the reading in hand if it is newer than them.
 */
function windowReadings(input: ReadingsInput, timed: TimedWindow): readonly LimitReading[] {
  const { span, startAt } = timed;
  const recorded =
    input.instance && Math.abs(input.instance.resetsAt - span.end) <= RESET_TOLERANCE_MS
      ? input.instance.readings.filter(([at]) => at >= startAt && at < span.end)
      : [];
  const newest = recorded.at(-1)?.[0] ?? Number.NEGATIVE_INFINITY;
  const live = input.checkedAt;
  return live > newest && live >= startAt && live < span.end
    ? [...recorded, [live, input.window.usedPercent] as const]
    : recorded;
}

/**
 * What the burn-down draws, from where spending is counted. The reference
 * line is the usual weekday pattern when `weights` are given, else even
 * spending over the counted time. Null for a window with no span or nothing in
 * it that counts.
 */
export function burnDownChart(
  input: ReadingsInput &
    PaceDetail & {
      readonly schedule?: LimitSchedule | undefined;
      readonly forecast?: Forecast | null | undefined;
    },
): BurnDownChart | null {
  const timed = timedWindow(input.window, input.schedule, input);
  if (timed === null) return null;
  const { span, startAt, startUsed, timeline, reference } = timed;
  const allowance = 100 - startUsed;
  const remaining = (usedPercent: number) => Math.max(0, 100 - usedPercent);
  return {
    start: startAt,
    end: span.end,
    referenceKind: reference,
    reference: timeline.breakpoints.map((point) => ({
      at: point.at,
      remainingPercent: allowance - (allowance * point.mass) / timeline.total,
    })),
    readings: windowReadings(input, timed).map(([at, used]) => ({
      at,
      remainingPercent: remaining(used),
    })),
    forecast: (input.forecast?.curve ?? []).map((point) => ({
      at: point.at,
      remainingPercent: remaining(point.usedPercent),
    })),
  };
}

export interface DailyBurn {
  /** The calendar day in the schedule's zone, `YYYY-MM-DD`. */
  readonly day: string;
  readonly from: number;
  readonly to: number;
  /** Points of allowance the reference line puts on this day. */
  readonly budgetPercent: number;
  /** Points used on the day, read off the recorded readings; null where none cover it. */
  readonly consumedPercent: number | null;
  /** The readings begin part way through this day. */
  readonly partial: boolean;
  readonly today: boolean;
}

/**
 * Each day of the window, from where spending is counted: what the reference
 * line allows it and what the readings say it used. Use is spread evenly over
 * the time between two readings, so a day the app was closed for is an estimate.
 */
export function dailyBurn(
  input: ReadingsInput &
    PaceDetail & {
      readonly now: number;
      readonly schedule?: LimitSchedule | undefined;
    },
): readonly DailyBurn[] | null {
  const timed = timedWindow(input.window, input.schedule, input);
  if (timed === null) return null;
  const { span, startAt, startUsed, timeline } = timed;
  const readings = windowReadings(input, timed);
  const first = readings[0];
  const last = readings.at(-1);
  const usedAt = (at: number) => {
    if (first === undefined || last === undefined) return 0;
    if (at <= first[0]) return first[1];
    if (at >= last[0]) return last[1];
    const upper = readings.findIndex(([when]) => when >= at);
    const [after, usedAfter] = readings[upper]!;
    const [before, usedBefore] = readings[upper - 1]!;
    return after === before
      ? usedAfter
      : usedBefore + ((usedAfter - usedBefore) * (at - before)) / (after - before);
  };
  return limitDaysBetween(input.schedule, startAt, span.end).map((entry) => {
    const used =
      first !== undefined && last !== undefined && entry.to > first[0] && entry.from < last[0]
        ? {
            points: Math.max(
              0,
              usedAt(Math.min(entry.to, last[0])) - usedAt(Math.max(entry.from, first[0])),
            ),
            partial: first[0] > entry.from,
          }
        : null;
    return {
      day: entry.day,
      from: entry.from,
      to: entry.to,
      budgetPercent:
        ((100 - startUsed) * (timeline.massBefore(entry.to) - timeline.massBefore(entry.from))) /
        timeline.total,
      consumedPercent: used?.points ?? null,
      partial: used?.partial ?? false,
      today: entry.from <= input.now && input.now < entry.to,
    };
  });
}
