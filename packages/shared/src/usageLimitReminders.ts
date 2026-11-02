/**
 * "Use it or lose it": the windows worth switching to before they reset, one
 * batched reminder for them, and a memory so each window is raised once.
 * @module usageLimitReminders
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  type DailyTokens,
  FORECAST_ALGORITHMS,
  type ForecastAlgorithm,
  forecastWindow,
} from "./usageLimitForecast.ts";
import {
  type LimitGroupOf,
  type LimitGroupState,
  limitGroupOf,
  resolveLimitSchedule,
} from "./usageLimitGroups.ts";
import {
  type LimitHistory,
  type LimitInstance,
  RESET_TOLERANCE_MS,
  limitSeriesKey,
} from "./usageLimitHistory.ts";
import {
  type LimitSchedule,
  isLimitActiveAt,
  limitActiveDayMs,
  limitDayKey,
  limitTimeline,
} from "./usageLimitSchedule.ts";
import { type LimitAccount, formatDuration, remainingPercent } from "./usageLimits.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type ReminderMode = "perWindow" | "digest" | "inApp" | "off";

const REMINDER_MODES: readonly ReminderMode[] = ["perWindow", "digest", "inApp", "off"];

export interface ReminderSettings {
  readonly mode: ReminderMode;
  /** Remind when at least this share is left and the forecast says it will go unused. */
  readonly thresholdPercent: number;
  readonly includeSession: boolean;
  /** The forecast the reminder and the burn-down chart share. */
  readonly algorithm: ForecastAlgorithm;
}

const MIN_REMINDER_THRESHOLD = 5;
const MAX_REMINDER_THRESHOLD = 95;

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  mode: "perWindow",
  thresholdPercent: 25,
  includeSession: false,
  algorithm: "runRate",
};

/** Settings from untrusted input, each field falling back to its default on its own. */
export function normalizeReminderSettings(value: unknown): ReminderSettings {
  const input =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const { mode, thresholdPercent, includeSession, algorithm } = input;
  const defaults = DEFAULT_REMINDER_SETTINGS;
  return {
    mode: REMINDER_MODES.find((candidate) => candidate === mode) ?? defaults.mode,
    thresholdPercent:
      typeof thresholdPercent === "number" && Number.isFinite(thresholdPercent)
        ? Math.max(
            MIN_REMINDER_THRESHOLD,
            Math.min(MAX_REMINDER_THRESHOLD, Math.round(thresholdPercent)),
          )
        : defaults.thresholdPercent,
    includeSession: typeof includeSession === "boolean" ? includeSession : defaults.includeSession,
    algorithm:
      FORECAST_ALGORITHMS.find((candidate) => candidate === algorithm) ?? defaults.algorithm,
  };
}

export interface UseItItem {
  /** Names this window until it resets, so a window is reminded of once. */
  readonly tag: string;
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly group: LimitGroupOf;
  readonly schedule: LimitSchedule | undefined;
  readonly remainingPercent: number;
  /** What the forecast leaves unspent; null when no forecast could be made. */
  readonly forecastUnusedPercent: number | null;
  readonly resetsAt: number;
}

export interface UseItInput {
  readonly accounts: readonly LimitAccount[];
  readonly groups: LimitGroupState;
  readonly settings: ReminderSettings;
  readonly history: LimitHistory;
  /** Daily token totals for the provider an account belongs to, if they are in hand. */
  readonly dailyTokens?:
    | ((account: LimitAccount) => readonly DailyTokens[] | undefined)
    | undefined;
  readonly now: number;
}

const KIND_RANK = { session: 0, weekly: 1, monthly: 2, other: 3 } as const;

/** Weekly windows get a day's notice, monthly ones three, sessions an hour, all in counted time. */
function leadMs(kind: ServerProviderUsageWindow["kind"], schedule: LimitSchedule | undefined) {
  const day = limitActiveDayMs(schedule);
  return kind === "monthly" ? 3 * day : kind === "weekly" ? day : HOUR;
}

/** A longer window that is spent and stays spent past this one's reset leaves nothing to use. */
function isBlocked(
  account: LimitAccount,
  window: ServerProviderUsageWindow,
  resetsAt: number,
): boolean {
  return account.limits.windows.some((other) => {
    if (other === window || KIND_RANK[other.kind] <= KIND_RANK[window.kind]) return false;
    if (other.usedPercent < 100) return false;
    const otherReset = other.resetsAt === undefined ? Number.NaN : Date.parse(other.resetsAt);
    return !Number.isFinite(otherReset) || otherReset >= resetsAt;
  });
}

function windowTag(
  series: string,
  instances: readonly LimitInstance[] | undefined,
  resetsAt: number,
): string {
  const current = instances?.at(-1);
  return current !== undefined && Math.abs(current.resetsAt - resetsAt) <= RESET_TOLERANCE_MS
    ? `${series}|${current.from}`
    : `${series}|${Math.round(resetsAt / RESET_TOLERANCE_MS)}`;
}

/**
 * The windows worth switching to now, soonest reset first: weekly or monthly
 * ones (session too, if asked) a day, three days or an hour from their reset in
 * counted time, with the threshold left and forecast unused, while the
 * account's schedule is in session.
 */
export function useItOrLoseIt(input: UseItInput): readonly UseItItem[] {
  const { accounts, groups, settings, history, now } = input;
  const items: UseItItem[] = [];
  for (const account of accounts) {
    const schedule = resolveLimitSchedule(groups, account);
    if (!isLimitActiveAt(schedule, now)) continue;
    const group = limitGroupOf(account, groups.assignments);
    for (const window of account.limits.windows) {
      if (window.kind === "other" || (window.kind === "session" && !settings.includeSession)) {
        continue;
      }
      const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
      if (!Number.isFinite(resetsAt) || resetsAt <= now || window.usedPercent >= 100) continue;
      const remaining = 100 - Math.max(0, window.usedPercent);
      if (remaining < settings.thresholdPercent || isBlocked(account, window, resetsAt)) continue;
      if (limitTimeline(schedule, now, resetsAt).total > leadMs(window.kind, schedule)) continue;
      const series = limitSeriesKey(account, window);
      const instances = history[series];
      const { forecast } = forecastWindow({
        window,
        now,
        schedule,
        algorithm: settings.algorithm,
        instances,
        dailyTokens: input.dailyTokens?.(account),
      });
      if (forecast !== null && forecast.unusedPercent < settings.thresholdPercent) continue;
      items.push({
        tag: windowTag(series, instances, resetsAt),
        account,
        window,
        group,
        schedule,
        remainingPercent: remaining,
        forecastUnusedPercent: forecast?.unusedPercent ?? null,
        resetsAt,
      });
    }
  }
  return items.sort(
    (left, right) =>
      left.resetsAt - right.resetsAt || right.remainingPercent - left.remainingPercent,
  );
}

/** What has been said already: window tags until their reset, and the day each group last had its digest. */
export interface ReminderState {
  /** Tag to the time to forget it. */
  readonly sent: Readonly<Record<string, number>>;
  readonly digestDay: Readonly<Record<string, string>>;
}

export const NO_REMINDER_STATE: ReminderState = { sent: {}, digestDay: {} };

export interface ReminderBatch {
  readonly items: readonly UseItItem[];
  /** Set for a digest, which is one group's and happens once a day. */
  readonly digest: { readonly groupKey: string; readonly day: string } | null;
}

/**
 * What to say now: one batch holding every qualifying window not yet
 * mentioned, or in digest mode one batch per group that has not had its
 * digest today. Nothing in the modes that stay in the app.
 */
export function planReminders(
  items: readonly UseItItem[],
  state: ReminderState,
  mode: ReminderMode,
  now: number,
): readonly ReminderBatch[] {
  const fresh = items.filter((item) => state.sent[item.tag] === undefined);
  if (mode === "perWindow") return fresh.length > 0 ? [{ items: fresh, digest: null }] : [];
  if (mode !== "digest") return [];
  const byGroup = new Map<string, UseItItem[]>();
  for (const item of fresh) {
    const list = byGroup.get(item.group.key);
    if (list) list.push(item);
    else byGroup.set(item.group.key, [item]);
  }
  return [...byGroup].flatMap(([groupKey, members]) => {
    const day = limitDayKey(members[0]!.schedule, now);
    return state.digestDay[groupKey] === day ? [] : [{ items: members, digest: { groupKey, day } }];
  });
}

/** A window is remembered a week past its reset, long enough that its tag cannot come back. */
const SENT_KEEP_MS = 7 * DAY;

/** Records a batch as said. */
export function markReminded(state: ReminderState, batch: ReminderBatch): ReminderState {
  const sent = { ...state.sent };
  for (const item of batch.items) sent[item.tag] = item.resetsAt + SENT_KEEP_MS;
  return {
    sent,
    digestDay: batch.digest
      ? { ...state.digestDay, [batch.digest.groupKey]: batch.digest.day }
      : state.digestDay,
  };
}

/** Forgets what is no longer needed; the same state comes back when nothing is. */
export function pruneReminderState(state: ReminderState, now: number): ReminderState {
  const sent = Object.entries(state.sent).filter(([, until]) => until > now);
  const oldestDay = limitDayKey(undefined, now - 7 * DAY);
  const digests = Object.entries(state.digestDay).filter(([, day]) => day >= oldestDay);
  if (
    sent.length === Object.keys(state.sent).length &&
    digests.length === Object.keys(state.digestDay).length
  ) {
    return state;
  }
  return { sent: Object.fromEntries(sent), digestDay: Object.fromEntries(digests) };
}

export const REMINDER_TITLE = "Use it or lose it";

/** `Claude (Work), Weekly: 45% left, resets in 18h 35m`. Emails are never printed. */
function reminderLine(
  item: UseItItem,
  now: number,
  nameOf: (account: LimitAccount) => string,
): string {
  const group = item.group.kind === "named" ? ` (${item.group.name})` : "";
  return `${nameOf(item.account)}${group}, ${item.window.label}: ${remainingPercent(item.window)}% left, resets in ${formatDuration(item.resetsAt - now)}`;
}

/** One line per window, soonest reset first, then what to do about it. */
export function reminderBody(
  items: readonly UseItItem[],
  now: number,
  nameOf: (account: LimitAccount) => string,
): string {
  const advice =
    items.length === 1
      ? "Switch to it today to use it before it resets."
      : "Switch to them today to use them before they reset.";
  return [...items.map((item) => reminderLine(item, now, nameOf)), advice].join("\n");
}
