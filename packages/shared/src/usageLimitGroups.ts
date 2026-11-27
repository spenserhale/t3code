/**
 * Splitting the Limits view into groups of subscription accounts, so quota that is not
 * interchangeable (personal and work, say) is never pooled. An account lands in the group it
 * was assigned, else under its email.
 * @module usageLimitGroups
 */
import type { LimitAccount, LimitPresentations } from "./usageLimits.ts";

/** A client's grouping preference. It names accounts by email, so it stays on the device. */
export interface LimitGroupState {
  readonly enabled: boolean;
  /** Group name by `limitSubscriptionId`, kept while the account is out of sight. */
  readonly assignments: Readonly<Record<string, string>>;
  /** Subscriptions already given what was saved under an id they had before; never given it again. */
  readonly migrated?: readonly string[] | undefined;
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
 * The identity an assignment is stored under. It is the way accounts merge across
 * environments (email, else credential), so every environment names a subscription the
 * same way. A new key, or a gained email, is a new account.
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
    ? { ...state, enabled: true, assignments: { ...rest, [subscriptionId]: trimmed } }
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

/** Today's key of each hub account, mapped to the keys it had before. */
export type FormerHubAccountKeys = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * A hub account's key was `<source id>:<account>` before it named the hub instead: the hub's
 * endpoint, or the environment and source id for a hub on the environment's own machine.
 */
export function formerHubAccountKeys(presentations: LimitPresentations): FormerHubAccountKeys {
  const former = new Map<string, Set<string>>();
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        const tail = `${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        for (const hub of [`${environmentId}:${source.id}`, source.endpoint]) {
          if (hub === undefined) continue;
          const key = `${hub}:${tail}`;
          former.set(key, (former.get(key) ?? new Set()).add(`${source.id}:${tail}`));
        }
      }
    }
  }
  return former;
}

/**
 * Ids an account was saved under by builds that named it otherwise. Only an account without
 * an email can have one: its key stood for it until its server named its credential, and a
 * hub account's key changed shape (`formerHubAccountKeys`).
 */
function formerLimitSubscriptionIds(
  account: LimitAccount,
  hubKeys: FormerHubAccountKeys | undefined,
): readonly string[] {
  if (accountEmail(account)) return [];
  return [account.key, ...(hubKeys?.get(account.key) ?? [])];
}

/**
 * Gives each account the group saved under an id it had before, once: an account's own
 * group is never overwritten, an id given one is never given one again (so a group taken
 * away stays away), and ids that disagree give none. The old entries stay saved.
 */
export function carryOverLimitGroups(
  state: LimitGroupState,
  accounts: readonly LimitAccount[],
  hubKeys?: FormerHubAccountKeys,
): LimitGroupState {
  const migrated = new Set(state.migrated);
  const assignments: Record<string, string> = { ...state.assignments };
  let changed = false;
  for (const account of accounts) {
    const id = limitSubscriptionId(account);
    if (migrated.has(id)) continue;
    const groups = new Set(
      formerLimitSubscriptionIds(account, hubKeys).flatMap((former) => {
        const group = former === id ? undefined : state.assignments[former]?.trim();
        return group ? [group] : [];
      }),
    );
    if (groups.size === 0) continue;
    migrated.add(id);
    changed = true;
    const [group] = groups;
    if (groups.size === 1 && group !== undefined) assignments[id] ??= group;
  }
  return changed ? { ...state, assignments, migrated: [...migrated] } : state;
}
