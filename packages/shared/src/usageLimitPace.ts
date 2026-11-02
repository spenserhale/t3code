// @effect-diagnostics globalDate:off -- A month before a reset is calendar arithmetic on an epoch.
/**
 * Pace against a schedule: the share of a window's allowance that even
 * spending over the counted time would have used by now, and whether it has.
 * @module usageLimitPace
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import { type ActiveTimeline, type LimitSchedule, limitTimeline } from "./usageLimitSchedule.ts";
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

export interface TimedWindow {
  readonly span: WindowSpan;
  readonly timeline: ActiveTimeline;
}

/** The window with the time that counts in it; null when it has no span or none of it counts. */
export function timedWindow(
  window: ServerProviderUsageWindow,
  schedule: LimitSchedule | undefined,
): TimedWindow | null {
  const span = windowSpan(window);
  if (span === null) return null;
  const timeline = limitTimeline(schedule, span.start, span.end);
  return timeline.total > 0 ? { span, timeline } : null;
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/** The share of a window's counted time that has passed, 0 to 1; null when it cannot be told. */
export function scheduledElapsedShare(
  window: ServerProviderUsageWindow,
  now: number,
  schedule?: LimitSchedule,
): number | null {
  const timed = timedWindow(window, schedule);
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
  /** What even spending would have used by now. */
  readonly expectedUsedPercent: number;
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
 * The pace of a window now, judged against the time that counts. Null when
 * the reset is unknown, nothing in the window counts, it has run less than
 * three percent of its counted time, or it already reset.
 */
export function windowPace(
  window: ServerProviderUsageWindow,
  now: number,
  schedule?: LimitSchedule,
): WindowPace | null {
  const timed = timedWindow(window, schedule);
  if (timed === null || timed.span.end <= now) return null;
  const { timeline } = timed;
  const elapsed = timeline.massBefore(now);
  const share = Math.max(0, Math.min(1, elapsed / timeline.total));
  if (share < MIN_ELAPSED_SHARE) return null;
  const used = clampPercent(window.usedPercent);
  const expected = share * 100;
  let outlook: PaceOutlook = { kind: "lasts" };
  if (used >= 100) outlook = { kind: "exhausted" };
  else if (used > 0) {
    const needed = ((100 - used) / used) * elapsed;
    if (elapsed + needed < timeline.total) {
      outlook = { kind: "runsOut", inMs: Math.max(0, timeline.timeAtMass(elapsed + needed) - now) };
    }
  }
  return {
    state: judge(used, expected),
    expectedUsedPercent: expected,
    gapPoints: used - expected,
    outlook,
  };
}

/**
 * The pace of the windows pooled in one bar. One account keeps its own
 * outlook. Several are judged on the windows that have a clock, by their mean
 * spend against their mean share of counted time; the pool has no outlook.
 */
export function pooledPace(
  entries: ReadonlyArray<{
    readonly window: ServerProviderUsageWindow;
    readonly schedule?: LimitSchedule | undefined;
  }>,
  now: number,
): WindowPace | null {
  const timed = entries.flatMap(({ window, schedule }) => {
    const share = scheduledElapsedShare(window, now, schedule);
    const span = windowSpan(window);
    return share === null || span === null || span.end <= now
      ? []
      : [{ window, schedule, used: clampPercent(window.usedPercent), share }];
  });
  if (timed.length === 0) return null;
  if (timed.length === 1) return windowPace(timed[0]!.window, now, timed[0]!.schedule);
  const share = timed.reduce((sum, entry) => sum + entry.share, 0) / timed.length;
  if (share < MIN_ELAPSED_SHARE) return null;
  const used = timed.reduce((sum, entry) => sum + entry.used, 0) / timed.length;
  return {
    state: judge(used, share * 100),
    expectedUsedPercent: share * 100,
    gapPoints: used - share * 100,
    outlook: null,
  };
}

/** Where the pace tick sits on a bar that shows what is left: the share even spending would have left. */
export function scheduledPaceRemaining(
  window: ServerProviderUsageWindow,
  now: number,
  schedule?: LimitSchedule,
): number | null {
  const pace = windowPace(window, now, schedule);
  return pace === null ? null : Math.round(100 - pace.expectedUsedPercent);
}

/** `On pace`, `6% in reserve`, `9% in deficit`. */
export function paceLabel(pace: WindowPace): string {
  if (pace.state === "on") return "On pace";
  const points = Math.round(Math.abs(pace.gapPoints));
  return pace.state === "under" ? `${points}% in reserve` : `${points}% in deficit`;
}

function paceExpected(pace: WindowPace): string {
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

/** `Pace: 6% in reserve | Expected 47% used | Lasts until reset`. */
export function paceSummary(pace: WindowPace): string {
  return ["Pace: " + paceLabel(pace), paceExpected(pace), paceOutlook(pace)]
    .filter((part) => part !== null)
    .join(" | ");
}
