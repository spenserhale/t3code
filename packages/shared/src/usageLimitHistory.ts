/**
 * A device-local record of how far each limit window was spent when read, as
 * providers report only the present. Readings belong to a window instance: one
 * account's one window between two resets.
 * @module usageLimitHistory
 */
import { limitSubscriptionId } from "./usageLimitGroups.ts";
import type { LimitAccount } from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Providers that derive a reset from the time of the call drift by seconds between reads. */
export const RESET_TOLERANCE_MS = 10 * MINUTE;

/** A fall in spend smaller than this is rounding, not a reset. */
const DROP_TOLERANCE_POINTS = 3;

export const HISTORY_MAX_AGE_MS = 120 * DAY;

/** Windows that ended longer ago than this keep only their final reading. */
export const HISTORY_DETAIL_MS = 14 * DAY;

const HISTORY_MAX_READINGS = 15_000;

export type LimitReading = readonly [at: number, usedPercent: number];

export interface LimitInstance {
  /** The reset as last reported, which settles the window's end. */
  readonly resetsAt: number;
  /** When this instance was first seen; it names the instance for as long as it lasts. */
  readonly from: number;
  /**
   * Set when a reset credit cleared the window before its reset: the first reading
   * after, where spending is counted from again.
   */
  readonly baseline?: LimitReading | undefined;
  /** At most one reading per hour, the latest of it, oldest first. The last is the final one once the window ends. */
  readonly readings: readonly LimitReading[];
}

/** Instances by series, oldest first. */
export type LimitHistory = Readonly<Record<string, readonly LimitInstance[]>>;

export const NO_LIMIT_HISTORY: LimitHistory = {};

export interface LimitSample {
  readonly series: string;
  readonly at: number;
  readonly usedPercent: number;
  readonly resetsAt: number;
}

/** One account's one window. Codex names its windows by slot, so it goes by kind. */
export function limitSeriesKey(
  account: LimitAccount,
  window: { readonly id: string; readonly kind: string },
): string {
  const slot = account.driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
  return `${limitSubscriptionId(account)}|${slot}`;
}

/**
 * What a read of the accounts says about their windows with a reset: session,
 * weekly and monthly ones. A reading is dated when the provider was asked,
 * not now, so a stale snapshot is never mistaken for a fresh one.
 */
export function limitSamples(accounts: readonly LimitAccount[], now: number): LimitSample[] {
  return accounts.flatMap((account) => {
    const read = Date.parse(account.limits.checkedAt);
    const at = Number.isFinite(read) ? Math.min(read, now) : now;
    return account.limits.windows.flatMap((window) => {
      const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
      if (window.kind === "other" || !Number.isFinite(resetsAt) || resetsAt <= at) return [];
      return [
        {
          series: limitSeriesKey(account, window),
          at,
          usedPercent: window.usedPercent,
          resetsAt,
        },
      ];
    });
  });
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

function withSample(instances: readonly LimitInstance[], sample: LimitSample) {
  const used = round1(clampPercent(sample.usedPercent));
  const last = instances.at(-1);
  const final = last?.readings.at(-1);
  if (last === undefined || final === undefined) {
    return [{ resetsAt: sample.resetsAt, from: sample.at, readings: [[sample.at, used]] as const }];
  }
  if (sample.at <= final[0]) return instances;
  const continues =
    Math.abs(last.resetsAt - sample.resetsAt) <= RESET_TOLERANCE_MS &&
    used >= final[1] - DROP_TOLERANCE_POINTS;
  if (!continues) {
    // The same window with less spent is one cleared early; a moved reset is a new window.
    const cleared = Math.abs(last.resetsAt - sample.resetsAt) <= RESET_TOLERANCE_MS;
    return [
      ...instances,
      {
        resetsAt: sample.resetsAt,
        from: sample.at,
        ...(cleared ? { baseline: [sample.at, used] as const } : {}),
        readings: [[sample.at, used]] as const,
      },
    ];
  }
  const sameHour = Math.floor(final[0] / HOUR) === Math.floor(sample.at / HOUR);
  if (sameHour && final[1] === used && last.resetsAt === sample.resetsAt) return instances;
  const kept = sameHour ? last.readings.slice(0, -1) : last.readings;
  return [
    ...instances.slice(0, -1),
    { ...last, resetsAt: sample.resetsAt, readings: [...kept, [sample.at, used] as const] },
  ];
}

/** Adds readings to the history; the same object comes back when none of them adds anything. */
export function recordLimitSamples(
  history: LimitHistory,
  samples: readonly LimitSample[],
): LimitHistory {
  let next: Record<string, readonly LimitInstance[]> | null = null;
  for (const sample of samples) {
    const before = (next ?? history)[sample.series] ?? [];
    const after = withSample(before, sample);
    if (after === before) continue;
    next ??= { ...history };
    next[sample.series] = after;
  }
  return next ?? history;
}

const countReadings = (history: LimitHistory) =>
  Object.values(history).reduce(
    (sum, instances) =>
      sum + instances.reduce((inner, instance) => inner + instance.readings.length, 0),
    0,
  );

/**
 * Keeps the history to 120 days and a fixed size. Windows that ended more
 * than two weeks ago keep only their final reading, which is all the
 * utilization strip needs. If that is still too many readings, the oldest
 * windows lose their detail first, then go altogether.
 */
export function pruneLimitHistory(
  history: LimitHistory,
  now: number,
  maxReadings = HISTORY_MAX_READINGS,
): LimitHistory {
  const trimmed: Record<string, LimitInstance[]> = {};
  for (const [series, instances] of Object.entries(history)) {
    const kept = instances
      .filter((instance) => instance.resetsAt >= now - HISTORY_MAX_AGE_MS)
      .map((instance) =>
        instance.resetsAt < now - HISTORY_DETAIL_MS && instance.readings.length > 1
          ? { ...instance, readings: instance.readings.slice(-1) }
          : instance,
      );
    if (kept.length > 0) trimmed[series] = kept;
  }
  let excess = countReadings(trimmed) - maxReadings;
  if (excess <= 0) return sameHistory(history, trimmed) ? history : trimmed;
  const entries = Object.entries(trimmed).flatMap(([series, instances]) =>
    instances.map((instance) => ({ series, instance, dropped: false })),
  );
  const oldestFirst = [...entries].sort(
    (left, right) => left.instance.resetsAt - right.instance.resetsAt,
  );
  for (const entry of oldestFirst) {
    if (excess <= 0) break;
    const { readings } = entry.instance;
    if (readings.length <= 1 || entry.instance.resetsAt >= now) continue;
    entry.instance = { ...entry.instance, readings: readings.slice(-1) };
    excess -= readings.length - 1;
  }
  for (const entry of oldestFirst) {
    if (excess <= 0) break;
    entry.dropped = true;
    excess -= entry.instance.readings.length;
  }
  const result: Record<string, LimitInstance[]> = {};
  for (const entry of entries) {
    if (!entry.dropped) (result[entry.series] ??= []).push(entry.instance);
  }
  return result;
}

function sameHistory(left: LimitHistory, right: LimitHistory): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const before = left[key]!;
    const after = right[key];
    return (
      after !== undefined &&
      before.length === after.length &&
      before.every((instance, index) => instance === after[index])
    );
  });
}

/** The instance whose window has not yet ended. */
export function currentLimitInstance(
  history: LimitHistory,
  series: string,
  now: number,
): LimitInstance | null {
  const last = history[series]?.at(-1);
  return last !== undefined && last.resetsAt > now ? last : null;
}

/** Where spending is counted from again in the window that ends at `resetsAt`, if it was cleared early. */
export function windowBaseline(
  instances: readonly LimitInstance[] | undefined,
  resetsAt: number,
): LimitReading | undefined {
  const current = instances?.at(-1);
  return current !== undefined && Math.abs(current.resetsAt - resetsAt) <= RESET_TOLERANCE_MS
    ? current.baseline
    : undefined;
}

export interface PastLimitWindow {
  readonly resetsAt: number;
  /** The last reading before the reset. */
  readonly usedPercent: number;
  /** How long before the reset that reading was taken. */
  readonly unseenMs: number;
  /** True when the reading is close enough to the reset to stand for how the window ended. */
  readonly complete: boolean;
}

/**
 * The last `count` windows of a series that ran to their reset, oldest first.
 * A window cleared early, by a reset credit or a provider moving its reset,
 * is not a window that was used or left unused, so it is left out.
 */
export function pastLimitWindows(
  history: LimitHistory,
  series: string,
  now: number,
  count: number,
  windowMs: number,
): readonly PastLimitWindow[] {
  const instances = history[series] ?? [];
  return instances
    .flatMap((instance, index): PastLimitWindow[] => {
      const final = instance.readings.at(-1);
      const successor = instances[index + 1];
      const ended = instance.resetsAt <= now;
      const clearedEarly =
        successor !== undefined && successor.from < instance.resetsAt - RESET_TOLERANCE_MS;
      if (!ended || clearedEarly || final === undefined) return [];
      const unseenMs = Math.max(0, instance.resetsAt - final[0]);
      return [
        {
          resetsAt: instance.resetsAt,
          usedPercent: final[1],
          unseenMs,
          complete: unseenMs <= Math.max(HOUR, windowMs * 0.05),
        },
      ];
    })
    .slice(-count);
}

/** The mean final spend of past windows; null when there are none. */
export function averageUtilization(windows: readonly PastLimitWindow[]): number | null {
  return windows.length === 0
    ? null
    : windows.reduce((sum, window) => sum + window.usedPercent, 0) / windows.length;
}
