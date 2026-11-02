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
const ByProviderSchema = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
);
const DailyTokensSchema = Schema.Struct({
  // Optional, so a cache that an earlier build kept as one total reads as empty.
  environments: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ at: Schema.Number, byProvider: ByProviderSchema }),
    ),
  ),
});
type Stored = typeof DailyTokensSchema.Type;
const MaybeDailyTokensSchema = Schema.NullOr(DailyTokensSchema);

/** Older totals say little about the present, and the forecast should not lean on them. */
const MAX_AGE_MS = 14 * 24 * 3_600_000;
const REFRESH_AFTER_MS = 12 * 3_600_000;
const RETRY_AFTER_MS = 30 * 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;

/** An environment that did not report its totals: when it last failed, and how often in a row. */
export interface TokenMiss {
  readonly at: number;
  readonly count: number;
}

/** Half an hour after the first miss, doubling with each further one, up to six hours. */
export function tokenRetryDelayMs(misses: number): number {
  return Math.min(RETRY_AFTER_MS * 2 ** Math.max(0, misses - 1), RETRY_MAX_MS);
}

/**
 * The ready environments to ask for their totals: those with none, or none from
 * the last half day, that are not waiting out a miss.
 */
export function environmentsDueForTokens(input: {
  readonly ready: readonly string[];
  readonly fetchedAt: Readonly<Record<string, number>>;
  readonly misses: ReadonlyMap<string, TokenMiss>;
  readonly now: number;
}): readonly string[] {
  return input.ready.filter((environmentId) => {
    const miss = input.misses.get(environmentId);
    if (miss !== undefined && input.now - miss.at < tokenRetryDelayMs(miss.count)) return false;
    const fetchedAt = input.fetchedAt[environmentId];
    return fetchedAt === undefined || input.now - fetchedAt >= REFRESH_AFTER_MS;
  });
}

function providerKindOf(account: LimitAccount): UsageProviderKind | undefined {
  return (Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[]).find(
    (kind) => PROVIDER_PRESENTATION[kind].driverKind === account.driver,
  );
}

/**
 * The cached daily totals for an account's provider, summed over the environments
 * whose totals are recent enough to trust. A source that several environments
 * report is counted by each, which scales a day's total and not the pattern of the week.
 */
export function dailyTokensFor(
  stored: Stored | null,
  account: LimitAccount,
  now: number,
): readonly DailyTokens[] | undefined {
  const kind = providerKindOf(account);
  if (stored === null || kind === undefined) return undefined;
  const totals = new Map<string, number>();
  for (const entry of Object.values(stored.environments ?? {})) {
    if (now - entry.at > MAX_AGE_MS) continue;
    for (const [day, tokens] of entry.byProvider[kind] ?? []) {
      totals.set(day, (totals.get(day) ?? 0) + tokens);
    }
  }
  return totals.size === 0
    ? undefined
    : [...totals].map(([day, tokens]): DailyTokens => ({ day, tokens }));
}

/** Tokens per day by provider, leaving out days with none, as the cache keeps them. */
export function dailyTokensByProvider(daily: readonly DailyTotals[]): typeof ByProviderSchema.Type {
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

/** When each environment's totals were last fetched. */
export function readDailyTokensFetchedAt(): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(read()?.environments ?? {}).map(([environmentId, entry]) => [
      environmentId,
      entry.at,
    ]),
  );
}

/** Keeps one environment's fetched totals, dated now, beside those of the others. */
export function cacheEnvironmentDailyTokens(
  environmentId: string,
  daily: readonly DailyTotals[],
  now: number,
): void {
  try {
    const others = Object.entries(read()?.environments ?? {}).filter(
      ([id, entry]) => id !== environmentId && now - entry.at <= MAX_AGE_MS,
    );
    setLocalStorageItem(
      STORAGE_KEY,
      {
        environments: {
          ...Object.fromEntries(others),
          [environmentId]: { at: now, byProvider: dailyTokensByProvider(daily) },
        },
      },
      DailyTokensSchema,
    );
    dispatchLocalStorageChange(STORAGE_KEY);
  } catch (error) {
    console.error("Could not save daily token totals.", error);
  }
}

export const DAILY_TOKENS_STORAGE_KEY = STORAGE_KEY;

let holds = 0;
const holdListeners = new Set<() => void>();

/**
 * Asks for the token totals while something that draws on them is on screen, even
 * with reminders off. Call the result when it goes.
 */
export function holdDailyTokens(): () => void {
  holds += 1;
  for (const listener of holdListeners) listener();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

export const dailyTokensHeld = () => holds > 0;

/** Called each time something starts asking for the totals. */
export function onDailyTokensHeld(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => {
    holdListeners.delete(listener);
  };
}
