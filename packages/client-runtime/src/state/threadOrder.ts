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

// Past the deadline, or woken by a request or failure. A manual unsnooze, a
// guest message and a subagent request leave no time on the shell.
function shellDatesWake(thread: ThreadSnoozeShell, now: string): boolean {
  if (!threadRaisedHandWhileSnoozed(thread)) return threadWokeAt(thread, { now }) !== null;
  return thread.source?.pendingRuntimeRequest != null || thread.latestRun?.status === "failed";
}

export interface InboxOrderOptions<T> {
  readonly now: string;
  /** Lower ranks list first; only the "status" order reads it. */
  readonly statusRank?: (thread: T) => number;
  /**
   * When this client saw the thread stop working or ask. Read only for requests
   * the shell cannot date.
   */
  readonly returnedAt?: (thread: T) => number | undefined;
  /** When this client saw a snooze end that left no wake time on the shell. */
  readonly wokeAt?: (thread: T) => number | undefined;
}

function lastStatusChangeTimestamp<T extends InboxOrderThreadInput>(
  thread: T,
  options: InboxOrderOptions<T>,
): number {
  // Runtime requests date themselves, and so do runs. Guest and subagent
  // requests do not, so only they fall back to what this client observed.
  const undatedRequest =
    thread.pendingSubagentRequest != null || (thread.pendingGuestMessageCount ?? 0) > 0;
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
    options.wokeAt?.(thread) ?? 0,
    undatedRequest ? (options.returnedAt?.(thread) ?? 0) : 0,
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

/**
 * Remembers when this client saw a snooze end that the shell does not date: a
 * manual unsnooze, a drag out of Snoozed, a guest message or a subagent request.
 * Keep one at module scope; call `observe` when the shells change, or with null
 * to stop.
 */
export function createInboxWakeTracker() {
  const keyOf = (thread: ThreadKeyInput) => `${thread.environmentId}:${thread.id}`;
  const snoozed = new Map<string, boolean>();
  const wakes = new Map<string, number>();
  return {
    observe(threads: readonly (ThreadKeyInput & ThreadSnoozeShell)[] | null, now: string): void {
      if (threads === null) {
        snoozed.clear();
        wakes.clear();
        return;
      }
      const nowMs = Date.parse(now);
      const present = new Set<string>();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        const asleep = effectiveSnoozed(thread, { now });
        if (
          snoozed.get(key) === true &&
          !asleep &&
          Number.isFinite(nowMs) &&
          !shellDatesWake(thread, now)
        ) {
          wakes.set(key, nowMs);
        }
        snoozed.set(key, asleep);
      }
      for (const map of [snoozed, wakes]) {
        for (const key of map.keys()) {
          if (!present.has(key)) map.delete(key);
        }
      }
    },
    /** For a wake the user causes here, so the order need not wait for the server to confirm it. */
    noteWake(thread: ThreadKeyInput, atMs: number): void {
      wakes.set(keyOf(thread), atMs);
    },
    wokeAt: (thread: ThreadKeyInput): number | undefined => wakes.get(keyOf(thread)),
  };
}
