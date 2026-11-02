import type { SidebarInboxThreadOrder } from "@t3tools/contracts/settings";
import type { EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";

export type InboxOrderThreadInput = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "createdAt"
  | "unsettledAt"
  | "snoozedUntil"
  | "latestRun"
  | "latestUserMessageAt"
  | "latestUserAuthoredMessageAt"
>;

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

function lastStatusChangeTimestamp(thread: InboxOrderThreadInput, nowMs: number): number {
  const snoozeWakeMs = toSortableTimestamp(thread.snoozedUntil ?? undefined);
  return Math.max(
    latestTimestamp(
      thread.createdAt,
      thread.unsettledAt,
      thread.latestRun?.requestedAt,
      thread.latestRun?.startedAt,
      thread.latestRun?.completedAt,
    ),
    snoozeWakeMs !== null && snoozeWakeMs <= nowMs ? snoozeWakeMs : 0,
  );
}

function lastActivityTimestamp(thread: InboxOrderThreadInput, nowMs: number): number {
  return Math.max(lastUserMessageTimestamp(thread), lastStatusChangeTimestamp(thread, nowMs));
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
  options: { readonly nowMs: number; readonly statusRank?: (thread: T) => number },
): T[] {
  const { nowMs, statusRank } = options;
  const keyed = threads.map((thread) => ({
    thread,
    rank: order === "status" && statusRank !== undefined ? statusRank(thread) : 0,
    timestamp:
      order === "last_user_message"
        ? lastUserMessageTimestamp(thread)
        : order === "last_status_change"
          ? lastStatusChangeTimestamp(thread, nowMs)
          : lastActivityTimestamp(thread, nowMs),
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
