import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";

import type { LimitAccount, LimitPoolMember } from "./usageLimits.ts";

type AccountKey = (driver: ServerProvider["driver"], email: string | undefined) => string | null;

/**
 * A provider account that holds several subscriptions, as one account per subscription, merged
 * by its own credential so it counts once across environments. Windows no subscription claims
 * stay on an account for the instance. The first entry to claim a window id owns it, and the
 * first entry for a credential stands for it.
 */
function subscriptionAccounts(
  environment: LimitAccount["environments"][number],
  provider: ServerProvider,
  limits: ServerProviderUsageLimits,
  accountKey: AccountKey,
): ReadonlyArray<readonly [string, LimitAccount]> {
  const instanceKey = `${environment.environmentId}:${provider.instanceId}`;
  const instanceName = provider.displayName?.trim() || null;
  const instance = {
    driver: provider.driver,
    email: provider.auth.email,
    plan: provider.auth.label,
    accentColor: provider.accentColor,
    environments: [environment],
    sourceLabel: null,
  };
  const native = {
    environmentId: environment.environmentId,
    input: { instanceId: provider.instanceId },
  };
  const claimed = new Set<string>();
  const credentials = new Set<string>();
  const accounts: Array<readonly [string, LimitAccount]> = [];
  const subscriptions = limits.subscriptions ?? [];
  for (const subscription of subscriptions) {
    if (credentials.has(subscription.credentialFingerprint)) continue;
    credentials.add(subscription.credentialFingerprint);
    const windows = limits.windows.filter(
      (window) => !claimed.has(window.id) && subscription.windowIds.includes(window.id),
    );
    for (const window of windows) claimed.add(window.id);
    accounts.push([
      `${provider.driver}:credential:${subscription.credentialFingerprint}`,
      {
        ...instance,
        key: `${instanceKey}:${subscription.credentialFingerprint}`,
        displayName: instanceName ? `${instanceName} · ${subscription.label}` : subscription.label,
        subscription: subscription.id,
        ...(subscription.credit ? { credit: subscription.credit } : {}),
        redeem: subscription.resetCredits ? native : null,
        limits: {
          checkedAt: subscription.checkedAt,
          windows,
          credentialFingerprint: subscription.credentialFingerprint,
          ...(subscription.resetCredits ? { resetCredits: subscription.resetCredits } : {}),
        },
      },
    ]);
  }
  // Credits no listed subscription carries, skipped repeats included, belong to the account as a whole.
  const unownedCredits = subscriptions.some((subscription) => subscription.resetCredits)
    ? undefined
    : limits.resetCredits;
  accounts.push([
    accountKey(provider.driver, provider.auth.email) ?? instanceKey,
    {
      ...instance,
      key: instanceKey,
      displayName: instanceName,
      redeem: unownedCredits ? native : null,
      limits: {
        checkedAt: limits.checkedAt,
        windows: limits.windows.filter((window) => !claimed.has(window.id)),
        ...(unownedCredits ? { resetCredits: unownedCredits } : {}),
      },
    },
  ]);
  return accounts.filter(([, account]) => account.limits.windows.length > 0);
}

/**
 * Merges a provider that lists its subscriptions as one account per subscription, and says
 * whether it did; one that lists none is left for the caller. `accountKey` keys the account that
 * keeps the windows no subscription claims, so it matches an unlisted account of the same login.
 */
export function mergeSubscriptions(
  merge: (key: string, account: LimitAccount) => void,
  environment: LimitAccount["environments"][number],
  provider: ServerProvider,
  accountKey: AccountKey,
): boolean {
  const limits = provider.usageLimits;
  if (!limits?.subscriptions?.length) return false;
  for (const [key, account] of subscriptionAccounts(environment, provider, limits, accountKey)) {
    merge(key, account);
  }
  return true;
}

/**
 * The accounts a pooled window gets a column for. Subscriptions of different
 * plans never share a window, so a column for an account on another plan
 * would be a permanent gap.
 */
export function accountsOnPlansOf(
  accounts: readonly LimitAccount[],
  members: readonly LimitPoolMember[],
): readonly LimitAccount[] {
  const plans = new Set(members.map((member) => member.account.subscription));
  return accounts.filter((account) => plans.has(account.subscription));
}
