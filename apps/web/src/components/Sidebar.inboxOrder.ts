import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { sortInboxThreadsByOrder } from "@t3tools/client-runtime/state/thread-order";
import type { SidebarInboxThreadOrder } from "@t3tools/contracts/settings";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";

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

export function isSidebarInboxTimeOrdered(order: SidebarInboxThreadOrder): boolean {
  return order !== "default";
}

export function sortSidebarInboxThreads(
  threads: readonly EnvironmentThreadShell[],
  order: Exclude<SidebarInboxThreadOrder, "default">,
  nowMs: number,
): EnvironmentThreadShell[] {
  return sortInboxThreadsByOrder(threads, order, {
    nowMs,
    statusRank: (thread) => STATUS_RANK[resolveSidebarThreadStatus(thread)],
  });
}
