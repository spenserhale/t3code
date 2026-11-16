/**
 * Current windows grouped by consumption scope for each subscription, with a
 * tightest-window summary retained for callers that need a single figure.
 *
 * @module usageLimitsGlance
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  type LimitGroup,
  type LimitGroupState,
  groupLimitAccounts,
  labelLimitAccounts,
  resolveLimitSchedule,
} from "./usageLimitGroups.ts";
import { type DailyTokens, paceDetailFor } from "./usageLimitForecast.ts";
import type { LimitHistory } from "./usageLimitHistory.ts";
import { type WindowPace, windowPace } from "./usageLimitPace.ts";
import {
  type LimitAccount,
  type LimitPoolMember,
  collectLimitPools,
  displayLimitWindows,
  remainingPercent,
} from "./usageLimits.ts";
import { cursorUsageWindowDetails, formatDuration, formatResetsIn } from "./usageLimitsCopy.ts";

export interface LimitGlanceRow {
  readonly account: LimitAccount;
  /** As `nameOf` gave it, numbered when another row in the section shares it. */
  readonly name: string;
  readonly pools: readonly LimitGlanceConsumption[];
  /**
   * True when every window the account reports has reset since it was read, so
   * there is no current figure to show; the other fields are then null.
   */
  readonly resetSinceChecked: boolean;
  /** The tightest window still counting down, under the label Limits gives it. */
  readonly windowLabel: string | null;
  readonly remainingPercent: number | null;
  /** `resets in 2h 13m`, or null when the window has no reset. */
  readonly resetsIn: string | null;
  /** How the window is pacing against the account's schedule; null when it cannot be judged. */
  readonly pace: WindowPace | null;
}

export interface LimitGlanceWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsIn: string | null;
  readonly resetsAt: number | null;
  readonly pace: WindowPace | null;
}

export interface LimitGlanceConsumption {
  readonly key: string;
  readonly label: string | null;
  readonly windows: readonly LimitGlanceWindow[];
}

const KIND_ORDER = { session: 0, weekly: 1, monthly: 2, other: 3 } as const;

function consumptionScope(account: LimitAccount, window: ServerProviderUsageWindow) {
  if (account.driver === "cursor") {
    return { key: window.id, label: cursorUsageWindowDetails(window.id)?.label ?? window.label };
  }
  const parts = window.label.split(" · ");
  if (account.driver === "antigravity") {
    return {
      key: window.id.replace(/-(5h|weekly|quota)$/, ""),
      label: parts.length > 1 ? parts.slice(0, -1).join(" · ") : window.label,
    };
  }
  if (account.driver === "claudeAgent" && window.id.startsWith("seven_day_")) {
    return { key: window.id, label: parts.slice(1).join(" · ") || window.label };
  }
  if (window.kind === "other") return { key: window.id, label: window.label };
  if (parts.length > 1) {
    const scope = parts.slice(0, -1).join(" · ");
    return { key: scope, label: scope === account.displayName ? null : scope };
  }
  return { key: "overall", label: null };
}

function periodLabel(window: ServerProviderUsageWindow) {
  if (window.kind === "session") {
    if (window.windowDurationMins && window.windowDurationMins % 60 === 0) {
      return `${window.windowDurationMins / 60}-hour`;
    }
    return window.windowDurationMins
      ? `${formatDuration(window.windowDurationMins * 60_000)} window`
      : (window.label.match(/(?:^| · )(\d+)[- ]hours?$/i)?.[0].replace(/^ · /, "") ?? "Session");
  }
  if (window.kind === "weekly") return "Weekly";
  if (window.kind === "monthly") return /credit/i.test(window.label) ? "Monthly credit" : "Monthly";
  return "Quota";
}

function consumptionPools(
  account: LimitAccount,
  windows: readonly ServerProviderUsageWindow[],
  paceOf: (window: ServerProviderUsageWindow) => WindowPace | null,
  now: number,
): readonly LimitGlanceConsumption[] {
  const pools = new Map<
    string,
    { key: string; label: string | null; windows: LimitGlanceWindow[] }
  >();
  for (const window of windows) {
    const scope = consumptionScope(account, window);
    // Distinct ids of the same kind are separate quotas even if their display labels coincide.
    const key = pools.get(scope.key)?.windows.some((entry) => entry.kind === window.kind)
      ? `${scope.key}:${window.id}`
      : scope.key;
    const pool = pools.get(key) ?? { ...scope, key, windows: [] };
    const at = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt);
    pool.windows.push({
      id: window.id,
      kind: window.kind,
      label: periodLabel(window),
      remainingPercent: remainingPercent(window),
      resetsIn: formatResetsIn(window, now),
      resetsAt: Number.isFinite(at) ? at : null,
      pace: paceOf(window),
    });
    pools.set(key, pool);
  }
  return [...pools.values()]
    .sort((left, right) => Number(right.label === null) - Number(left.label === null))
    .map((pool) => ({
      ...pool,
      label: pool.label ?? (pools.size > 1 ? "Overall" : null),
      windows: pool.windows.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]),
    }));
}

export interface LimitGlanceSection {
  /** The group the rows belong to, or null for the one list drawn without groups. */
  readonly group: LimitGroup | null;
  readonly rows: readonly LimitGlanceRow[];
}

export interface LimitGlance {
  readonly sections: readonly LimitGlanceSection[];
  /** The oldest readable read among the rows, so the summary never claims to be fresher than it is. */
  readonly checkedAt: string | null;
}

/**
 * `checked 3m ago`, or `checked just now` for a read from the last minute or
 * one a skewed clock dates ahead of this one. Null when `checkedAt` is not a
 * date, as it is only a string on the wire.
 */
export function formatCheckedAgo(checkedAt: string, now: number): string | null {
  const readAt = Date.parse(checkedAt);
  if (!Number.isFinite(readAt)) return null;
  const age = now - readAt;
  return age >= 60_000 ? `checked ${formatDuration(age)} ago` : "checked just now";
}

/** A reset before `now` happened after the window was read, so what it reported is out of date. */
function hasReset(window: ServerProviderUsageWindow, now: number): boolean {
  if (window.resetsAt === undefined) return false;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) && at < now;
}

/**
 * Sections follow Limits' account grouping, with subscriptions ordered by
 * their soonest current reset. Cursor's combined allowance is hidden by the
 * whole section, with a fallback when an account has no visible live window.
 */
export function collectLimitGlance(
  accounts: readonly LimitAccount[],
  groups: LimitGroupState,
  now: number,
  nameOf: (account: LimitAccount) => string,
  /** What pace is judged by beyond the schedule: recorded clearings, and token history for the usual pattern. */
  extras: {
    readonly history?: LimitHistory | undefined;
    readonly dailyTokens?:
      | ((account: LimitAccount) => readonly DailyTokens[] | undefined)
      | undefined;
  } = {},
): LimitGlance {
  const section = (group: LimitGroup | null, members: readonly LimitAccount[]) => {
    const pools = collectLimitPools(members, now);
    const shown = new Map<string, ServerProviderUsageWindow[]>();
    const reported = new Map<string, ServerProviderUsageWindow[]>();
    const add = (
      into: Map<string, ServerProviderUsageWindow[]>,
      members: readonly LimitPoolMember[],
    ) => {
      for (const { account, window } of members) {
        const list = into.get(account.key);
        if (list) list.push(window);
        else into.set(account.key, [window]);
      }
    };
    for (const pool of pools) {
      for (const { members } of pool.windows) add(reported, members);
      for (const { members } of displayLimitWindows(pool)) add(shown, members);
    }
    // Equal shares left go to the window Limits lists first: session, weekly, monthly, then the rest.
    const tightest = (windows: readonly ServerProviderUsageWindow[] = []) =>
      windows
        .filter((candidate) => !hasReset(candidate, now))
        .sort((left, right) => remainingPercent(left) - remainingPercent(right))[0];
    return {
      group,
      rows: labelLimitAccounts(
        pools.map((pool) => pool.accounts),
        nameOf,
      )
        .flatMap(({ account, label }): LimitGlanceRow[] => {
          if (!reported.has(account.key)) return [];
          const schedule = resolveLimitSchedule(groups, account);
          const live = (shown.get(account.key) ?? []).filter((entry) => !hasReset(entry, now));
          const current =
            live.length > 0
              ? live
              : (reported.get(account.key) ?? []).filter((entry) => !hasReset(entry, now));
          const nested = consumptionPools(
            account,
            current,
            (window) =>
              windowPace(
                window,
                now,
                schedule,
                paceDetailFor({ account, window, schedule, now, ...extras }),
              ),
            now,
          );
          // A window Limits hides still counts when none it shows is left to read.
          const window = tightest(shown.get(account.key)) ?? tightest(reported.get(account.key));
          // Every window the account reports has reset since it was read.
          if (!window) {
            return [
              {
                account,
                name: label,
                pools: [],
                resetSinceChecked: true,
                windowLabel: null,
                remainingPercent: null,
                resetsIn: null,
                pace: null,
              },
            ];
          }
          const pool = pools.find((candidate) => candidate.driver === account.driver);
          const details =
            pool?.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool) : undefined;
          return [
            {
              account,
              name: label,
              pools: nested,
              resetSinceChecked: false,
              windowLabel: details?.label ?? window.label,
              remainingPercent: remainingPercent(window),
              resetsIn: formatResetsIn(window, now),
              pace:
                nested.flatMap((pool) => pool.windows).find((entry) => entry.id === window.id)
                  ?.pace ?? null,
            },
          ];
        })
        .sort((left, right) => {
          const nextReset = (row: LimitGlanceRow) =>
            Math.min(
              ...row.pools.flatMap((pool) =>
                pool.windows.map((window) => window.resetsAt ?? Infinity),
              ),
            );
          return nextReset(left) - nextReset(right);
        }),
    };
  };
  const sections = (
    groups.enabled
      ? groupLimitAccounts(accounts, groups.assignments).map((group) =>
          section(group, group.accounts),
        )
      : [section(null, accounts)]
  ).filter((candidate) => candidate.rows.length > 0);
  const [checkedAt = null] = sections
    .flatMap((candidate) => candidate.rows.map((row) => row.account.limits.checkedAt))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return { sections, checkedAt };
}
