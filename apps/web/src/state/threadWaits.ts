/**
 * Thread waits (fork): "snooze until another thread is done". Everything here is empty or false
 * for environments without the `threadWaits` capability, so callers need no checks of their own.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createThreadWaitEnvironmentAtoms } from "@t3tools/client-runtime/state/threadWaits";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { threadWaitLabel } from "../components/threadWait.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadShell } from "./entities";
import { environmentPresentations } from "./presentation";

export const threadWaitEnvironment = createThreadWaitEnvironmentAtoms(
  connectionAtomRuntime,
  environmentPresentations.serverConfigsAtom,
);

/**
 * The thread `threadKey` waits on, or null. A primitive per row, so a change to the waits
 * re-renders only the rows whose answer changed.
 */
export const threadWaitBlockerAtom = Atom.family((threadKey: string) =>
  Atom.make((get): ThreadId | null => {
    const ref = parseScopedThreadKey(threadKey);
    if (ref === null) return null;
    return (
      get(threadWaitEnvironment.index(ref.environmentId)).waitingOn(ref.threadId)
        ?.blockerThreadId ?? null
    );
  }).pipe(Atom.withLabel(`thread-waits:blocker:${threadKey}`)),
);

/** How many threads wait on `threadKey`. */
export const threadWaitBlockingCountAtom = Atom.family((threadKey: string) =>
  Atom.make((get): number => {
    const ref = parseScopedThreadKey(threadKey);
    if (ref === null) return 0;
    return get(threadWaitEnvironment.index(ref.environmentId)).blockingCount(ref.threadId);
  }).pipe(Atom.withLabel(`thread-waits:blocking:${threadKey}`)),
);

/**
 * For menus built in event handlers: undefined when the environment cannot wait, otherwise
 * whether the thread waits now. Sidebar rows keep the waits subscribed while the app is open.
 */
export function readThreadWaitMenuState(
  threadRef: ScopedThreadRef,
): { readonly waiting: boolean } | undefined {
  if (!appAtomRegistry.get(threadWaitEnvironment.supported(threadRef.environmentId))) {
    return undefined;
  }
  const index = appAtomRegistry.get(threadWaitEnvironment.index(threadRef.environmentId));
  return { waiting: index.waitingOn(threadRef.threadId) !== null };
}

export function readThreadWaits(environmentId: ScopedThreadRef["environmentId"]) {
  return {
    supported: appAtomRegistry.get(threadWaitEnvironment.supported(environmentId)),
    waits: appAtomRegistry.get(threadWaitEnvironment.index(environmentId)).waits,
  };
}

/** "Waiting on <title>" while `thread` waits on another thread, otherwise null. */
export function useThreadWaitLabel(
  thread: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly id: ThreadId;
  } | null,
): string | null {
  const threadKey = thread ? scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) : "";
  const blockerId = useAtomValue(threadWaitBlockerAtom(threadKey));
  const blocker = useThreadShell(
    thread && blockerId ? scopeThreadRef(thread.environmentId, blockerId) : null,
  );
  return blockerId === null ? null : threadWaitLabel(blocker?.title);
}
