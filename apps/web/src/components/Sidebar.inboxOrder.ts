import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  createInboxWakeTracker,
  sortInboxThreadsByOrder,
} from "@t3tools/client-runtime/state/thread-order";
import type { SidebarInboxThreadOrder } from "@t3tools/contracts/settings";
import {
  applySidebarThreadDrop,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "./Sidebar.logic";

// Threads that need the user lead, then broken runs, then running work, then
// idle threads.
const STATUS_RANK: Record<SidebarThreadStatus, number> = {
  approval: 0,
  input: 0,
  request: 0,
  failed: 1,
  limited: 1,
  working: 2,
  waiting: 2,
  ready: 3,
};

export const inboxWakes = createInboxWakeTracker();

export function isSidebarInboxTimeOrdered(order: SidebarInboxThreadOrder): boolean {
  return order !== "default";
}

/** These orders read status changes, so the trackers must be observing. */
export function isSidebarInboxStatusOrdered(order: SidebarInboxThreadOrder): boolean {
  return order === "last_status_change" || order === "status";
}

export function sortSidebarInboxThreads(
  threads: readonly EnvironmentThreadShell[],
  order: Exclude<SidebarInboxThreadOrder, "default">,
  now: string,
  returnedAt: (thread: EnvironmentThreadShell) => number | undefined,
): EnvironmentThreadShell[] {
  return sortInboxThreadsByOrder(threads, order, {
    now,
    statusRank: (thread) => STATUS_RANK[resolveSidebarThreadStatus(thread)],
    returnedAt,
    wokeAt: inboxWakes.wokeAt,
  });
}

/** A drop out of Snoozed reads as a snooze that ended at the drop, which the sort counts as a wake. */
export function projectSidebarInboxDrop(
  thread: EnvironmentThreadShell,
  now: string,
): EnvironmentThreadShell {
  const dropped = applySidebarThreadDrop(thread, "active", now);
  return effectiveSnoozed(thread, { now }) ? { ...dropped, snoozedUntil: now } : dropped;
}
