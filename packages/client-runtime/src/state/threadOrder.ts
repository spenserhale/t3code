import type { SidebarInboxThreadOrder } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  effectiveSnoozed,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";
import { toSortableTimestamp } from "./threadSort.ts";

type ThreadKeyInput = Pick<EnvironmentThreadShell, "environmentId" | "id">;

export type InboxOrderThreadInput = ThreadKeyInput &
  Pick<EnvironmentThreadShell, "createdAt" | "unsettledAt" | "latestUserAuthoredMessageAt"> &
  ThreadSnoozeShell;

function latestTimestamp(...candidates: ReadonlyArray<string | null | undefined>): number {
  let latest = 0;
  for (const candidate of candidates) {
    const parsed = toSortableTimestamp(candidate ?? undefined);
    if (parsed !== null && parsed > latest) latest = parsed;
  }
  return latest;
}

function lastUserMessageTimestamp(thread: InboxOrderThreadInput): number {
  // Older servers omit the authored field; their latestUserMessageAt is the
  // closest stand-in.
  const userMessageAt =
    thread.latestUserAuthoredMessageAt === undefined
      ? thread.latestUserMessageAt
      : thread.latestUserAuthoredMessageAt;
  return latestTimestamp(userMessageAt) || latestTimestamp(thread.createdAt);
}

function requestTimestamp(thread: ThreadSnoozeShell): number {
  const createdAt = thread.source?.pendingRuntimeRequest?.createdAt;
  const parsed = createdAt === undefined ? Number.NaN : DateTime.toEpochMillis(createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

// threadWokeAt answers an early wake with the thread's updatedAt, which moves
// with every event. The request or failure that woke the thread has its own time.
function scheduledWakeAt(thread: ThreadSnoozeShell, now: string): string | null {
  return threadRaisedHandWhileSnoozed(thread) ? null : threadWokeAt(thread, { now });
}

// The shell dates a wake when the deadline passed, or a request or failure came
// after the snooze began. A cleared snooze (manual unsnooze, drag) and guest or
// subagent requests leave no time, however old the thread's last failure is.
function shellDatesWake(thread: ThreadSnoozeShell, now: string): boolean {
  if (thread.snoozedUntil == null) return false;
  if (!threadRaisedHandWhileSnoozed(thread)) return threadWokeAt(thread, { now }) !== null;
  if (thread.source?.pendingRuntimeRequest != null) return true;
  const failedAt = thread.latestRun?.status === "failed" ? thread.latestRun.completedAt : null;
  return (
    failedAt != null &&
    (thread.snoozedAt == null || Date.parse(failedAt) > Date.parse(thread.snoozedAt))
  );
}

export interface InboxOrderOptions<T> {
  readonly now: string;
  /** Lower ranks list first; only the "status" order reads it. */
  readonly statusRank?: (thread: T) => number;
  /** When this client saw a status change the shell does not date. */
  readonly changedAt?: (thread: T) => number | undefined;
}

function lastStatusChangeTimestamp<T extends InboxOrderThreadInput>(
  thread: T,
  options: InboxOrderOptions<T>,
): number {
  return Math.max(
    latestTimestamp(
      thread.createdAt,
      thread.unsettledAt,
      thread.latestRun?.requestedAt,
      thread.latestRun?.startedAt,
      thread.latestRun?.completedAt,
      scheduledWakeAt(thread, options.now),
    ),
    requestTimestamp(thread),
    options.changedAt?.(thread) ?? 0,
  );
}

function lastActivityTimestamp<T extends InboxOrderThreadInput>(
  thread: T,
  options: InboxOrderOptions<T>,
): number {
  return Math.max(lastUserMessageTimestamp(thread), lastStatusChangeTimestamp(thread, options));
}

/**
 * Orders the inbox (unsettled, unpinned, unsnoozed) list by a time-based
 * setting, newest first. "status" groups by `statusRank` (lower first) and
 * orders each group by last activity; clients own status resolution, so the
 * rank arrives as a callback.
 */
export function sortInboxThreadsByOrder<T extends InboxOrderThreadInput>(
  threads: readonly T[],
  order: Exclude<SidebarInboxThreadOrder, "default">,
  options: InboxOrderOptions<T>,
): T[] {
  const { statusRank } = options;
  const keyed = threads.map((thread) => ({
    thread,
    rank: order === "status" && statusRank !== undefined ? statusRank(thread) : 0,
    timestamp:
      order === "last_user_message"
        ? lastUserMessageTimestamp(thread)
        : order === "last_status_change"
          ? lastStatusChangeTimestamp(thread, options)
          : lastActivityTimestamp(thread, options),
  }));
  keyed.sort(
    (left, right) =>
      left.rank - right.rank ||
      right.timestamp - left.timestamp ||
      left.thread.id.localeCompare(right.thread.id) ||
      left.thread.environmentId.localeCompare(right.thread.environmentId),
  );
  return keyed.map(({ thread }) => thread);
}

/** Where the tracker keeps what it dated, so it survives a reload. Keys are `environment:thread`. */
export interface InboxChangeStore {
  readonly load: () => Readonly<Record<string, number>>;
  readonly save: (changes: Readonly<Record<string, number>>) => void;
}

export interface InboxChangeTrackerOptions {
  readonly store?: InboxChangeStore;
  readonly maxEntries?: number;
  readonly maxAgeMs?: number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Dates the status changes the shell leaves undated: a snooze that ended with no
 * deadline, request or failure to show for it, and a guest or subagent request
 * appearing. Its history is bounded and outlives `observe(null)`, which only
 * forgets what was last seen. Keep one at module scope.
 */
export function createInboxChangeTracker(options: InboxChangeTrackerOptions = {}) {
  const { store, maxEntries = DEFAULT_MAX_ENTRIES, maxAgeMs = DEFAULT_MAX_AGE_MS } = options;
  const keyOf = (thread: ThreadKeyInput) => `${thread.environmentId}:${thread.id}`;
  const seen = new Map<string, { asleep: boolean; guest: boolean; subagent: boolean }>();
  let changes: Map<string, number> | undefined;
  const history = () => {
    if (changes === undefined) {
      changes = new Map();
      for (const [key, at] of Object.entries(store?.load() ?? {})) {
        if (Number.isFinite(at)) changes.set(key, at);
      }
    }
    return changes;
  };
  const persist = (atMs: number) => {
    const map = history();
    for (const [key, at] of map) {
      if (at < atMs - maxAgeMs) map.delete(key);
    }
    const excess = map.size - maxEntries;
    if (excess > 0) {
      for (const [key] of [...map].sort((a, b) => a[1] - b[1]).slice(0, excess)) {
        map.delete(key);
      }
    }
    store?.save(Object.fromEntries(map));
  };
  return {
    /** Call when the shells change, or with null while the order does not need it. */
    observe(threads: readonly (ThreadKeyInput & ThreadSnoozeShell)[] | null, now: string): void {
      if (threads === null) {
        seen.clear();
        return;
      }
      const nowMs = Date.parse(now);
      const present = new Set<string>();
      let stamped = false;
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        const asleep = effectiveSnoozed(thread, { now });
        const guest = (thread.pendingGuestMessageCount ?? 0) > 0;
        const subagent = thread.pendingSubagentRequest != null;
        const before = seen.get(key);
        if (
          before !== undefined &&
          Number.isFinite(nowMs) &&
          ((before.asleep && !asleep && !shellDatesWake(thread, now)) ||
            (guest && !before.guest) ||
            (subagent && !before.subagent))
        ) {
          history().set(key, nowMs);
          stamped = true;
        }
        seen.set(key, { asleep, guest, subagent });
      }
      for (const key of seen.keys()) {
        if (!present.has(key)) seen.delete(key);
      }
      if (stamped) persist(nowMs);
    },
    /** For a wake the user causes here, so the order need not wait for the server to confirm it. */
    noteWake(thread: ThreadKeyInput, atMs: number): void {
      if (!Number.isFinite(atMs)) return;
      history().set(keyOf(thread), atMs);
      persist(atMs);
    },
    changedAt: (thread: ThreadKeyInput): number | undefined => history().get(keyOf(thread)),
  };
}
