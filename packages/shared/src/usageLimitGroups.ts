/**
 * Splitting the Limits view into groups of subscription accounts, so quota
 * that is not interchangeable (personal and work, say) is never pooled into
 * one number. An account lands in the group it was assigned, else with the
 * other accounts under its email.
 *
 * @module usageLimitGroups
 */
import type { LimitAccount } from "./usageLimits.ts";

/** A client's grouping preference. It names accounts by email, so it stays on the device. */
export interface LimitGroupState {
  readonly enabled: boolean;
  /** Group name by `limitSubscriptionId`, kept while the account is out of sight. */
  readonly assignments: Readonly<Record<string, string>>;
}

/** The longest group name kept; a longer one is cut to this. */
export const MAX_LIMIT_GROUP_NAME_LENGTH = 40;

export const NO_LIMIT_GROUPS: LimitGroupState = { enabled: false, assignments: {} };

export interface LimitGroup {
  readonly key: string;
  readonly kind: "named" | "email" | "other";
  /** The assigned name, the lowercased email, or the catch-all's label. */
  readonly name: string;
  readonly accounts: readonly LimitAccount[];
}

function accountEmail(account: LimitAccount): string | undefined {
  return account.email?.trim().toLowerCase() || undefined;
}

/**
 * The identity an assignment is stored under. It follows the way accounts
 * merge across environments (email, else credential), so it names the same
 * subscription whichever environment reports it first. It holds while the
 * account keeps its email, or, with none, its credential; signing in with a
 * different key, or gaining an email, makes it a new account to assign.
 */
export function limitSubscriptionId(account: LimitAccount): string {
  const email = accountEmail(account);
  if (email) return `${account.driver}:${email}`;
  return account.limits.credentialFingerprint
    ? `${account.driver}:credential:${account.limits.credentialFingerprint}`
    : account.key;
}

function compareNames(left: string, right: string): number {
  return left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right);
}

/**
 * Lists accounts for editing one row each: providers in the order given,
 * accounts within a provider by name, then subscription id, none of which
 * moves with quota data, so a refresh never reorders rows or swaps the
 * numbers given to accounts that share a name. Those get an ordinal.
 */
export function labelLimitAccounts(
  providers: ReadonlyArray<readonly LimitAccount[]>,
  nameOf: (account: LimitAccount) => string,
): ReadonlyArray<{ readonly account: LimitAccount; readonly label: string }> {
  const named = providers.flatMap((accounts) =>
    accounts
      .map((account) => ({ account, name: nameOf(account), id: limitSubscriptionId(account) }))
      .sort(
        (left, right) => compareNames(left.name, right.name) || compareNames(left.id, right.id),
      ),
  );
  const seen = new Map<string, number>();
  return named.map(({ account, name }) => {
    const sharing = named.filter((other) => other.name === name).length;
    const ordinal = (seen.get(name) ?? 0) + 1;
    seen.set(name, ordinal);
    return { account, label: sharing > 1 ? `${name} ${ordinal}` : name };
  });
}

/**
 * Accounts split into the groups to draw, named groups first, then one per
 * email, then the accounts with neither. Each group pools separately, so pass
 * its accounts to `collectLimitPools` on their own.
 */
export function groupLimitAccounts(
  accounts: readonly LimitAccount[],
  assignments: LimitGroupState["assignments"],
): readonly LimitGroup[] {
  const named = new Map<string, LimitAccount[]>();
  const byEmail = new Map<string, LimitAccount[]>();
  const other: LimitAccount[] = [];
  const add = (groups: Map<string, LimitAccount[]>, name: string, account: LimitAccount) => {
    const list = groups.get(name);
    if (list) list.push(account);
    else groups.set(name, [account]);
  };
  for (const account of accounts) {
    const assigned = assignments[limitSubscriptionId(account)]?.trim();
    const email = accountEmail(account);
    if (assigned) add(named, assigned, account);
    else if (email) add(byEmail, email, account);
    else other.push(account);
  }
  const ordered = (kind: "named" | "email", groups: Map<string, LimitAccount[]>) =>
    [...groups]
      .sort(([left], [right]) => compareNames(left, right))
      .map(([name, accounts]): LimitGroup => ({ key: `${kind}:${name}`, kind, name, accounts }));
  return [
    ...ordered("named", named),
    ...ordered("email", byEmail),
    ...(other.length > 0
      ? [{ key: "other", kind: "other" as const, name: "Other accounts", accounts: other }]
      : []),
  ];
}

/**
 * Puts a subscription in a named group, or back with its email when the name
 * is blank. Naming a group is asking for the grouped view, so it turns it on.
 */
export function assignLimitGroup(
  state: LimitGroupState,
  subscriptionId: string,
  name: string,
): LimitGroupState {
  const trimmed = name.trim().slice(0, MAX_LIMIT_GROUP_NAME_LENGTH).trimEnd();
  const { [subscriptionId]: _previous, ...rest } = state.assignments;
  return trimmed
    ? { enabled: true, assignments: { ...rest, [subscriptionId]: trimmed } }
    : { ...state, assignments: rest };
}

/** Shows or hides the grouped view. Assignments survive being switched off. */
export function setLimitGroupsEnabled(state: LimitGroupState, enabled: boolean): LimitGroupState {
  return { ...state, enabled };
}

/** Every group name in use, to offer when assigning another account. */
export function limitGroupNames(assignments: LimitGroupState["assignments"]): readonly string[] {
  return [...new Set(Object.values(assignments))].sort(compareNames);
}
