import type { ServerProvider } from "@t3tools/contracts";

/**
 * Drop each provider's `usageLimits.subscriptions`, which only a client that
 * asked for them is sent. Returns the same array when there was nothing to drop.
 */
export function withoutUsageLimitSubscriptions(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  if (!providers.some((provider) => provider.usageLimits?.subscriptions !== undefined)) {
    return providers;
  }
  return providers.map((provider) => {
    if (provider.usageLimits?.subscriptions === undefined) return provider;
    const { subscriptions: _subscriptions, ...usageLimits } = provider.usageLimits;
    return { ...provider, usageLimits };
  });
}

/**
 * The providers one subscriber is sent: with each account's subscriptions only
 * when it asked for them, so a client that predates the field never sees it.
 */
export function providersFor(
  providers: readonly ServerProvider[],
  subscriber: { readonly usageLimitSubscriptions?: boolean | undefined },
): readonly ServerProvider[] {
  return subscriber.usageLimitSubscriptions === true
    ? providers
    : withoutUsageLimitSubscriptions(providers);
}
