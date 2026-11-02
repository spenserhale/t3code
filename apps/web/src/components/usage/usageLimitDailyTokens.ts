import type { UsageProviderKind } from "@t3tools/contracts";
import type { DailyTokens } from "@t3tools/shared/usageLimitForecast";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import * as Schema from "effect/Schema";

import {
  dispatchLocalStorageChange,
  getLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "../../hooks/useLocalStorage";
import { PROVIDER_PRESENTATION } from "./usageProviders";

const STORAGE_KEY = "t3code:usage-limit-daily-tokens:v1";
const DailyTokensSchema = Schema.Struct({
  at: Schema.Number,
  byProvider: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
  ),
});
type Stored = typeof DailyTokensSchema.Type;
const MaybeDailyTokensSchema = Schema.NullOr(DailyTokensSchema);

/** Older totals say little about the present, and the forecast should not lean on them. */
const MAX_AGE_MS = 14 * 24 * 3_600_000;
const REFRESH_AFTER_MS = 12 * 3_600_000;

function providerKindOf(account: LimitAccount): UsageProviderKind | undefined {
  return (Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[]).find(
    (kind) => PROVIDER_PRESENTATION[kind].driverKind === account.driver,
  );
}

/** The cached daily totals for an account's provider, if they are recent enough to trust. */
export function dailyTokensFor(
  stored: Stored | null,
  account: LimitAccount,
  now: number,
): readonly DailyTokens[] | undefined {
  const kind = providerKindOf(account);
  if (stored === null || kind === undefined || now - stored.at > MAX_AGE_MS) return undefined;
  return stored.byProvider[kind]?.map(([day, tokens]): DailyTokens => ({ day, tokens }));
}

/** Tokens per day by provider, leaving out days with none, as the cache keeps them. */
export function dailyTokensByProvider(daily: readonly DailyTotals[]): Stored["byProvider"] {
  const byProvider: Record<string, Array<readonly [string, number]>> = {};
  for (const day of daily) {
    for (const [provider, totals] of day.byProvider) {
      if (totals.totalTokens > 0) (byProvider[provider] ??= []).push([day.day, totals.totalTokens]);
    }
  }
  return byProvider;
}

function read(): Stored | null {
  try {
    return getLocalStorageItem(STORAGE_KEY, DailyTokensSchema);
  } catch {
    return null;
  }
}

/** Daily token totals per provider as last cached, for the places that cannot ask for them. */
export function readDailyTokens(now: number) {
  const stored = read();
  return (account: LimitAccount) => dailyTokensFor(stored, account, now);
}

export function useDailyTokens(now: number) {
  const [stored] = useLocalStorage(STORAGE_KEY, null as Stored | null, MaybeDailyTokensSchema);
  return (account: LimitAccount) => dailyTokensFor(stored, account, now);
}

/** Keeps the totals in the cache, rewriting only when they changed or have grown old. */
export function cacheDailyTokens(daily: readonly DailyTotals[], now: number): void {
  const byProvider = dailyTokensByProvider(daily);
  const before = read();
  if (
    before !== null &&
    now - before.at < REFRESH_AFTER_MS &&
    JSON.stringify(before.byProvider) === JSON.stringify(byProvider)
  ) {
    return;
  }
  try {
    setLocalStorageItem(STORAGE_KEY, { at: now, byProvider }, DailyTokensSchema);
    dispatchLocalStorageChange(STORAGE_KEY);
  } catch (error) {
    console.error("Could not save daily token totals.", error);
  }
}
