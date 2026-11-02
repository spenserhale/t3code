import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  createInboxChangeTracker,
  sortInboxThreadsByOrder,
} from "@t3tools/client-runtime/state/thread-order";
import type { SidebarInboxThreadOrder } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
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

const INBOX_CHANGES_STORAGE_KEY = "t3code:sidebar:inbox-status-changes:v1";
const InboxChangesSchema = Schema.Record(Schema.String, Schema.Finite);

export const inboxChanges = createInboxChangeTracker({
  store: {
    load: () => {
      try {
        return getLocalStorageItem(INBOX_CHANGES_STORAGE_KEY, InboxChangesSchema) ?? {};
      } catch (error) {
        console.error("Could not read the inbox status changes.", error);
        return {};
      }
    },
    save: (changes) => {
      try {
        setLocalStorageItem(INBOX_CHANGES_STORAGE_KEY, changes, InboxChangesSchema);
      } catch (error) {
        console.error("Could not save the inbox status changes.", error);
      }
    },
  },
});

export function isSidebarInboxTimeOrdered(order: SidebarInboxThreadOrder): boolean {
  return order !== "default";
}

/** These orders read status changes, so the tracker must be observing. */
export function isSidebarInboxStatusOrdered(order: SidebarInboxThreadOrder): boolean {
  return order === "last_status_change" || order === "status";
}

export function sortSidebarInboxThreads(
  threads: readonly EnvironmentThreadShell[],
  order: Exclude<SidebarInboxThreadOrder, "default">,
  now: string,
): EnvironmentThreadShell[] {
  return sortInboxThreadsByOrder(threads, order, {
    now,
    statusRank: (thread) => STATUS_RANK[resolveSidebarThreadStatus(thread)],
    changedAt: inboxChanges.changedAt,
  });
}

/**
 * A drop out of Snoozed reads as a snooze that ended at the drop, which the sort counts as a wake.
 * It keeps snoozedAt, so a failure from before the snooze does not read as a raised hand.
 */
export function projectSidebarInboxDrop<
  T extends Parameters<typeof applySidebarThreadDrop>[0] & ThreadSnoozeShell,
>(thread: T, now: string): T {
  const dropped = applySidebarThreadDrop(thread, "active", now);
  return effectiveSnoozed(thread, { now })
    ? { ...dropped, snoozedAt: thread.snoozedAt, snoozedUntil: now }
    : dropped;
}
