import {
  type LimitHistory,
  NO_LIMIT_HISTORY,
  limitSamples,
  pruneLimitHistory,
  recordLimitSamples,
} from "@t3tools/shared/usageLimitHistory";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import {
  dispatchLocalStorageChange,
  getLocalStorageItem,
  setLocalStorageItem,
  subscribeLocalStorageKey,
} from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-limit-history:v1";
const HistorySchema = Schema.Record(
  Schema.String,
  Schema.Array(
    Schema.Struct({
      resetsAt: Schema.Number,
      from: Schema.Number,
      readings: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
    }),
  ),
);

let decoded: { readonly raw: string | null; readonly history: LimitHistory } | null = null;

function storedText(): string | null | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return undefined;
  }
}

/**
 * The stored history. It is decoded again only when the stored text has changed,
 * because it can be large, is read on every push of limits, and a store snapshot
 * must be the same object until something changes.
 */
export function readUsageLimitHistory(): LimitHistory {
  const raw = storedText();
  if (raw === undefined) return NO_LIMIT_HISTORY;
  if (decoded?.raw === raw) return decoded.history;
  let history = NO_LIMIT_HISTORY;
  try {
    history = getLocalStorageItem(STORAGE_KEY, HistorySchema) ?? NO_LIMIT_HISTORY;
  } catch (error) {
    console.error("Could not read Limits history.", error);
  }
  decoded = { raw, history };
  return history;
}

/**
 * Adds what the accounts report now to the history, as stored now so another
 * window's readings are kept, and returns the result. Nothing is written when
 * the readings add nothing.
 */
export function recordUsageLimitHistory(
  accounts: readonly LimitAccount[],
  now: number,
): LimitHistory {
  const before = readUsageLimitHistory();
  const after = pruneLimitHistory(recordLimitSamples(before, limitSamples(accounts, now)), now);
  if (after === before) return before;
  try {
    setLocalStorageItem(STORAGE_KEY, after, HistorySchema);
    decoded = { raw: storedText() ?? null, history: after };
    dispatchLocalStorageChange(STORAGE_KEY);
  } catch (error) {
    console.error("Could not save Limits history.", error);
  }
  return after;
}

const subscribe = (onChange: () => void) => subscribeLocalStorageKey(STORAGE_KEY, onChange);

/** The recorded history, following the recorder in this or any other window. */
export function useUsageLimitHistory(): LimitHistory {
  return useSyncExternalStore(subscribe, readUsageLimitHistory, () => NO_LIMIT_HISTORY);
}
