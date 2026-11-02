// @effect-diagnostics globalDate:off -- A month before a reset is calendar arithmetic on an epoch.
/**
 * Pace against a schedule: the share of a window's allowance that even
 * spending over the counted time would have used by now, and whether it has.
 * @module usageLimitPace
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import type { LimitReading } from "./usageLimitHistory.ts";
import {
  type ActiveTimeline,
  type LimitSchedule,
  type WeekdayWeights,
  limitTimeline,
} from "./usageLimitSchedule.ts";
import { type LimitPace, formatDuration } from "./usageLimits.ts";

const MINUTE = 60_000;

/** Within this many points of even spending counts as on pace. */
const ON_PACE_POINTS = 2;

/** A window this young has too little behind it to judge. */
const MIN_ELAPSED_SHARE = 0.03;

export interface WindowSpan {
  readonly start: number;
  readonly end: number;
}

function oneMonthBefore(end: number): number {
  const date = new Date(end);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const lastDayBefore = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Date.UTC(
    year,
    month - 1,
    Math.min(date.getUTCDate(), lastDayBefore),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
}

/**
 * Where a window starts and ends. Providers send the reset and the length;
 * a monthly window without a length is a billing month, so it starts one
 * calendar month before its reset. Null when the reset is unknown.
 */
export function windowSpan(window: ServerProviderUsageWindow): WindowSpan | null {
  if (window.resetsAt === undefined) return null;
  const end = Date.parse(window.resetsAt);
  if (!Number.isFinite(end)) return null;
  if (window.windowDurationMins !== undefined && window.windowDurationMins > 0) {
    return { start: end - window.windowDurationMins * MINUTE, end };
  }
  return window.kind === "monthly" ? { start: oneMonthBefore(end), end } : null;
}

/** What changes where a window's spending is judged from, and against what. */
export interface PaceDetail {
  /** Set when a reset credit cleared the window early: spending is counted from this reading. */
  readonly baseline?: LimitReading | undefined;
  /** The usual spend by weekday. When set, even spending follows it instead of flat counted time. */
  readonly weights?: WeekdayWeights | null | undefined;
}

export interface TimedWindow {
  readonly span: WindowSpan;
  /** Where counting starts: the window's start, or the clearing when one fell inside it. */
  readonly startAt: number;
  /** What was already spent at `startAt`. */
  readonly startUsed: number;
  /** The reference line: how counted time, or the usual pattern, accrues from `startAt` to the reset. */
  readonly timeline: ActiveTimeline;
  /** Whether the line follows the usual pattern or spreads evenly over counted time. */
  readonly reference: "pattern" | "even";
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/** The window with the time that counts in it; null when it has no span or none of it counts. */
export function timedWindow(
  window: ServerProviderUsageWindow,
  schedule: LimitSchedule | undefined,
  detail?: PaceDetail,
): TimedWindow | null {
  const span = windowSpan(window);
  if (span === null) return null;
  const baseline = detail?.baseline;
  const cleared = baseline !== undefined && baseline[0] > span.start && baseline[0] < span.end;
  const startAt = cleared ? baseline[0] : span.start;
  const startUsed = cleared ? clampPercent(baseline[1]) : 0;
  const weights = detail?.weights ?? undefined;
  let timeline = limitTimeline(schedule, startAt, span.end, weights);
  let reference: TimedWindow["reference"] = weights ? "pattern" : "even";
  // A pattern with nothing on the days that count says nothing about them.
  if (weights && !(timeline.total > 0)) {
    timeline = limitTimeline(schedule, startAt, span.end);
    reference = "even";
  }
  return timeline.total > 0 ? { span, startAt, startUsed, timeline, reference } : null;
}

/** The share of a window's counted time that has passed, 0 to 1; null when it cannot be told. */
export function scheduledElapsedShare(
  window: ServerProviderUsageWindow,
  now: number,
  schedule?: LimitSchedule,
  detail?: PaceDetail,
): number | null {
  const timed = timedWindow(window, schedule, detail);
  return timed === null
    ? null
    : Math.max(0, Math.min(1, timed.timeline.massBefore(now) / timed.timeline.total));
}

export type PaceOutlook =
  | { readonly kind: "lasts" }
  | { readonly kind: "runsOut"; readonly inMs: number }
  | { readonly kind: "exhausted" };

export interface WindowPace {
  readonly state: LimitPace;
  /** What spending on the reference line would have used by now. */
  readonly expectedUsedPercent: number;
  /** The line it was judged against: the usual pattern, or even spending over counted time. */
  readonly reference: TimedWindow["reference"];
  /** Used minus expected, in points; positive is spending ahead of the schedule. */
  readonly gapPoints: number;
  /** What the pace so far means for the rest of the window; null for a pool of accounts. */
  readonly outlook: PaceOutlook | null;
}

function judge(usedPercent: number, expectedPercent: number): LimitPace {
  const gap = usedPercent - expectedPercent;
  if (gap > ON_PACE_POINTS) return "ahead";
  if (gap < -ON_PACE_POINTS) return "under";
  return "on";
}

/**
 * The pace of a window now, against its reference line; null when the reset is
 * unknown, nothing counts, under three percent of the counted time (from a
 * clearing, if any) has run, or it reset. The outlook follows the same line.
 */
export function windowPace(
  window: ServerProviderUsageWindow,
  now: number,
  schedule?: LimitSchedule,
  detail?: PaceDetail,
): WindowPace | null {
  const timed = timedWindow(window, schedule, detail);
  if (timed === null || timed.span.end <= now) return null;
  const { timeline, startUsed } = timed;
  const elapsed = timeline.massBefore(now);
  const share = Math.max(0, Math.min(1, elapsed / timeline.total));
  if (share < MIN_ELAPSED_SHARE) return null;
  const used = clampPercent(window.usedPercent);
  const expected = startUsed + (100 - startUsed) * share;
  const spent = Math.max(0, used - startUsed);
  let outlook: PaceOutlook = { kind: "lasts" };
  if (used >= 100) outlook = { kind: "exhausted" };
  else if (spent > 0) {
    const needed = ((100 - used) / spent) * elapsed;
    if (elapsed + needed < timeline.total) {
      outlook = { kind: "runsOut", inMs: Math.max(0, timeline.timeAtMass(elapsed + needed) - now) };
    }
  }
  return {
    state: judge(used, expected),
    expectedUsedPercent: expected,
    reference: timed.reference,
    gapPoints: used - expected,
    outlook,
  };
}

/**
 * The pace of the windows pooled in one bar. One account keeps its own
 * outlook. Several are judged on the windows that have a clock, by their mean
 * spend against their mean expected spend; the pool has no outlook.
 */
export function pooledPace(
  entries: ReadonlyArray<
    PaceDetail & {
      readonly window: ServerProviderUsageWindow;
      readonly schedule?: LimitSchedule | undefined;
    }
  >,
  now: number,
): WindowPace | null {
  const timed = entries.flatMap((entry) => {
    const window = timedWindow(entry.window, entry.schedule, entry);
    if (window === null || window.span.end <= now) return [];
    const share = Math.max(0, Math.min(1, window.timeline.massBefore(now) / window.timeline.total));
    return [
      {
        entry,
        reference: window.reference,
        share,
        used: clampPercent(entry.window.usedPercent),
        expected: window.startUsed + (100 - window.startUsed) * share,
      },
    ];
  });
  if (timed.length === 0) return null;
  if (timed.length === 1) {
    const { entry } = timed[0]!;
    return windowPace(entry.window, now, entry.schedule, entry);
  }
  const mean = (pick: (item: (typeof timed)[number]) => number) =>
    timed.reduce((sum, item) => sum + pick(item), 0) / timed.length;
  if (mean((item) => item.share) < MIN_ELAPSED_SHARE) return null;
  const used = mean((item) => item.used);
  const expected = mean((item) => item.expected);
  return {
    state: judge(used, expected),
    expectedUsedPercent: expected,
    reference: timed.every((item) => item.reference === "pattern") ? "pattern" : "even",
    gapPoints: used - expected,
    outlook: null,
  };
}

/** Where the pace tick sits on a bar that shows what is left: the share the reference line would have left. */
export function scheduledPaceRemaining(
  window: ServerProviderUsageWindow,
  now: number,
  schedule?: LimitSchedule,
  detail?: PaceDetail,
): number | null {
  const pace = windowPace(window, now, schedule, detail);
  return pace === null ? null : Math.round(100 - pace.expectedUsedPercent);
}

/** `On pace`, `6% in reserve`, `9% in deficit`. */
export function paceLabel(pace: WindowPace): string {
  if (pace.state === "on") return "On pace";
  const points = Math.round(Math.abs(pace.gapPoints));
  return pace.state === "under" ? `${points}% in reserve` : `${points}% in deficit`;
}

export function paceExpected(pace: WindowPace): string {
  return `Expected ${Math.round(pace.expectedUsedPercent)}% used`;
}

/** `Lasts until reset`, `Runs out in 2d 4h`; null where there is nothing to say. */
export function paceOutlook(pace: WindowPace): string | null {
  const outlook = pace.outlook;
  if (outlook === null) return null;
  if (outlook.kind === "lasts") return "Lasts until reset";
  if (outlook.kind === "exhausted") return "Limit reached";
  return outlook.inMs < MINUTE
    ? "Runs out within a minute"
    : `Runs out in ${formatDuration(outlook.inMs)}`;
}

/** One phrase for a crowded place: when the window runs out, else how it is pacing. */
export function paceBrief(pace: WindowPace): string {
  return pace.outlook?.kind === "runsOut"
    ? (paceOutlook(pace) ?? paceLabel(pace))
    : paceLabel(pace);
}

/** `Pace: 6% in reserve | Expected 47% used | Lasts until reset`. */
export function paceSummary(pace: WindowPace): string {
  return ["Pace: " + paceLabel(pace), paceExpected(pace), paceOutlook(pace)]
    .filter((part) => part !== null)
    .join(" | ");
}
