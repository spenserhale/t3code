import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/** Fork-only. Servers that serve these advertise the `threadWaits` capability. */
export const THREAD_WAIT_WS_METHODS = {
  subscribe: "threadWaits.subscribe",
  set: "threadWaits.set",
  clear: "threadWaits.clear",
} as const;

/**
 * Thread `threadId` is snoozed until `blockerThreadId` settles, is archived, or is deleted.
 * `snoozedUntil` is the plain snooze the link set; a thread snoozed to any other time is no
 * longer held by its link.
 */
export const ThreadWait = Schema.Struct({
  threadId: ThreadId,
  blockerThreadId: ThreadId,
  snoozedUntil: IsoDateTime,
  createdAt: IsoDateTime,
});
export type ThreadWait = typeof ThreadWait.Type;

/** Every wait in the environment, sent whole on subscribe and after each change. */
export const ThreadWaitList = Schema.Struct({ waits: Schema.Array(ThreadWait) });
export type ThreadWaitList = typeof ThreadWaitList.Type;

/** Whether `threadId` waiting on `blockerThreadId` closes a loop through `waits`. */
export function wouldCreateThreadWaitCycle(
  waits: ReadonlyArray<Pick<ThreadWait, "threadId" | "blockerThreadId">>,
  threadId: ThreadId,
  blockerThreadId: ThreadId,
): boolean {
  const blockerOf = new Map(waits.map((wait) => [wait.threadId, wait.blockerThreadId]));
  const seen = new Set<ThreadId>();
  for (let current: ThreadId | undefined = blockerThreadId; current !== undefined;) {
    if (current === threadId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = blockerOf.get(current);
  }
  return false;
}

export const ThreadWaitSubscribeInput = Schema.Struct({});
export type ThreadWaitSubscribeInput = typeof ThreadWaitSubscribeInput.Type;

/** Snoozes `threadId` and links it to `blockerThreadId`, replacing any wait it had. */
export const ThreadWaitSetInput = Schema.Struct({
  threadId: ThreadId,
  blockerThreadId: ThreadId,
});
export type ThreadWaitSetInput = typeof ThreadWaitSetInput.Type;

/** Drops `threadId`'s wait; `wake` also unsnoozes it. */
export const ThreadWaitClearInput = Schema.Struct({
  threadId: ThreadId,
  wake: Schema.Boolean,
});
export type ThreadWaitClearInput = typeof ThreadWaitClearInput.Type;

export const ThreadWaitErrorReason = Schema.Literals([
  "unavailable",
  "self",
  "cycle",
  "thread-not-found",
  "thread-inactive",
  "blocker-not-found",
  "blocker-inactive",
  "snooze-failed",
  "wake-failed",
]);
export type ThreadWaitErrorReason = typeof ThreadWaitErrorReason.Type;

export class ThreadWaitError extends Schema.TaggedError<ThreadWaitError>()("ThreadWaitError", {
  reason: ThreadWaitErrorReason,
  message: Schema.String,
}) {}

export const WsThreadWaitsSubscribeRpc = Rpc.make(THREAD_WAIT_WS_METHODS.subscribe, {
  payload: ThreadWaitSubscribeInput,
  success: ThreadWaitList,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsThreadWaitsSetRpc = Rpc.make(THREAD_WAIT_WS_METHODS.set, {
  payload: ThreadWaitSetInput,
  success: ThreadWait,
  error: Schema.Union([ThreadWaitError, EnvironmentAuthorizationError]),
});

export const WsThreadWaitsClearRpc = Rpc.make(THREAD_WAIT_WS_METHODS.clear, {
  payload: ThreadWaitClearInput,
  success: Schema.Void,
  error: Schema.Union([ThreadWaitError, EnvironmentAuthorizationError]),
});
