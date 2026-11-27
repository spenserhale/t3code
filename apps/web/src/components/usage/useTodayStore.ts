import type { UseItItem } from "@t3tools/shared/usageLimitReminders";
import { useSyncExternalStore } from "react";

export interface UseTodaySnapshot {
  readonly items: readonly UseItItem[];
  /** When the list was worked out; the countdowns on show are measured from it. */
  readonly now: number;
}

const EMPTY: UseTodaySnapshot = { items: [], now: 0 };
const listeners = new Set<() => void>();
let current = EMPTY;

/** Called by the tracker with what it found. An empty list is one shared object, so quiet minutes wake nobody. */
export function publishUseToday(items: readonly UseItItem[], now: number): void {
  const next = items.length === 0 ? EMPTY : { items, now };
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The subscriptions worth switching to today, soonest reset first. */
export function useUseToday(): UseTodaySnapshot {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
}

/** Whether anything is worth switching to; it changes only when that does. */
export function useHasUseToday(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current.items.length > 0,
    () => false,
  );
}
