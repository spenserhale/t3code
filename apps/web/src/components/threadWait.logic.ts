import { wouldCreateCycle } from "@t3tools/client-runtime/state/threadWaits";
import {
  type EnvironmentId,
  isListedThreadLineage,
  type ThreadId,
  type ThreadWait,
  type ThreadWaitErrorReason,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export type ThreadWaitThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "title" | "archivedAt" | "settledOverride" | "lineage" | "deletedAt"
>;

type WaitLinks = ReadonlyArray<Pick<ThreadWait, "threadId" | "blockerThreadId">>;

const isOpen = (thread: ThreadWaitThread) =>
  thread.archivedAt === null && thread.deletedAt === null && thread.settledOverride !== "settled";

/** Whether `thread` may still be snoozed on another thread. */
export function canThreadWait(thread: ThreadWaitThread): boolean {
  return isOpen(thread) && isListedThreadLineage(thread.lineage);
}

/** Whether `waiting` may be snoozed until `blocker` is done; the server checks again. */
export function isThreadWaitBlockerCandidate(
  blocker: ThreadWaitThread,
  waiting: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
  waits: WaitLinks,
): boolean {
  return (
    blocker.environmentId === waiting.environmentId &&
    blocker.id !== waiting.id &&
    canThreadWait(blocker) &&
    !wouldCreateCycle(waits, waiting.id, blocker.id)
  );
}

/** The picker's rows: open listed threads of the same environment, matching `query`, newest first. */
export function listThreadWaitBlockerCandidates<
  T extends ThreadWaitThread & Pick<EnvironmentThreadShell, "projectId" | "updatedAt">,
>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly waiting: { readonly environmentId: EnvironmentId; readonly id: ThreadId };
  readonly waits: WaitLinks;
  readonly query: string;
  readonly projectTitle: (thread: T) => string | null;
}): T[] {
  const query = input.query.trim().toLowerCase();
  return input.threads
    .filter(
      (thread) =>
        isThreadWaitBlockerCandidate(thread, input.waiting, input.waits) &&
        (query.length === 0 ||
          thread.title.toLowerCase().includes(query) ||
          (input.projectTitle(thread)?.toLowerCase().includes(query) ?? false)),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const displayTitle = (title: string | null | undefined) => title?.trim() || null;

export function threadWaitLabel(blockerTitle: string | null | undefined): string {
  const title = displayTitle(blockerTitle);
  return title === null ? "Waiting on a thread" : `Waiting on ${title}`;
}

export function threadWaitDropLabel(blockerTitle: string | null | undefined): string {
  const title = displayTitle(blockerTitle);
  return title === null ? "Snooze until a thread is done" : `Snooze until ${title} is done`;
}

export function threadWaitBlocksLabel(count: number): string {
  return `blocks ${count}`;
}

const REASON_MESSAGES: Record<ThreadWaitErrorReason, string> = {
  unavailable: "This server cannot link threads right now.",
  self: "A thread cannot wait on itself.",
  cycle: "That thread already waits on this one.",
  "thread-not-found": "This thread no longer exists.",
  "thread-inactive": "Settled or archived threads cannot wait.",
  "blocker-not-found": "That thread no longer exists.",
  "blocker-inactive": "That thread is already settled or archived.",
  "snooze-failed": "The thread could not be snoozed.",
  "wake-failed": "The thread could not be woken.",
};

export function threadWaitErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { _tag, reason, message } = error as {
      _tag?: unknown;
      reason?: unknown;
      message?: unknown;
    };
    if (_tag === "ThreadWaitError" && typeof reason === "string" && reason in REASON_MESSAGES) {
      return REASON_MESSAGES[reason as ThreadWaitErrorReason];
    }
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "An error occurred.";
}
