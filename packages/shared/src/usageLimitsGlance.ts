/**
 * The Limits view cut down to what fits a glance: one row per subscription
 * account, showing the window it has least of left.
 *
 * @module usageLimitsGlance
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  type LimitGroup,
  type LimitGroupState,
  groupLimitAccounts,
  labelLimitAccounts,
} from "./usageLimitGroups.ts";
import {
  type LimitAccount,
  type LimitPoolMember,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatDuration,
  formatResetsIn,
  remainingPercent,
} from "./usageLimits.ts";

export interface LimitGlanceRow {
  readonly account: LimitAccount;
  /** As `nameOf` gave it, numbered when another row in the section shares it. */
  readonly name: string;
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
 * Accounts as rows, in the sections and provider order Limits uses: one list
 * when groups are off, one section per group when they are on. Within a
 * provider, rows sort by name so a refresh never reorders them.
 *
 * Each row shows the window its account has least of left, among the windows
 * Limits shows for the provider's accounts in that section (Cursor's combined
 * figure is hidden or not by the whole pool, as on the page) and that have
 * not reset since they were read. An account with none of those left falls
 * back to its hidden windows, so it keeps a row, and counts as reset only
 * when every window it reports has. Windows with the same share left go to
 * the one Limits lists first: session, weekly, monthly, then the rest.
 */
export function collectLimitGlance(
  accounts: readonly LimitAccount[],
  groups: LimitGroupState,
  now: number,
  nameOf: (account: LimitAccount) => string,
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
    const tightest = (windows: readonly ServerProviderUsageWindow[] = []) =>
      windows
        .filter((candidate) => !hasReset(candidate, now))
        .sort((left, right) => remainingPercent(left) - remainingPercent(right))[0];
    return {
      group,
      rows: labelLimitAccounts(
        pools.map((pool) => pool.accounts),
        nameOf,
      ).flatMap(({ account, label }): LimitGlanceRow[] => {
        if (!reported.has(account.key)) return [];
        // A window Limits hides still counts when none it shows is left to read.
        const window = tightest(shown.get(account.key)) ?? tightest(reported.get(account.key));
        if (!window) {
          return [
            {
              account,
              name: label,
              resetSinceChecked: true,
              windowLabel: null,
              remainingPercent: null,
              resetsIn: null,
            },
          ];
        }
        const details =
          account.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
        return [
          {
            account,
            name: label,
            resetSinceChecked: false,
            windowLabel: details?.label ?? window.label,
            remainingPercent: remainingPercent(window),
            resetsIn: formatResetsIn(window, now),
          },
        ];
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
