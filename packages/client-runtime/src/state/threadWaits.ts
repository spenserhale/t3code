/**
 * Thread waits (fork): snooze a thread until another settles. Gate every read and write on
 * `supportsThreadWaits`; `index(environmentId)` already does. Writes are
 * `setThreadWait` / `clearThreadWait` commands, run with a `{ environmentId, input }` target.
 */
import {
  type EnvironmentId,
  THREAD_WAIT_WS_METHODS,
  type ThreadId,
  type ThreadWait,
  wouldCreateThreadWaitCycle,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

interface ThreadWaitCapabilityConfig {
  readonly environment: { readonly capabilities: { readonly threadWaits?: boolean | undefined } };
}

/**
 * Whether the environment serves `threadWaits.*`. Official servers never do.
 * @public
 */
export const supportsThreadWaits = (config: ThreadWaitCapabilityConfig | null | undefined) =>
  config?.environment.capabilities.threadWaits === true;

/** Whether `threadId` waiting on `blockerThreadId` would close a loop; such picks are refused. */
export const wouldCreateCycle = (
  waits: ReadonlyArray<Pick<ThreadWait, "threadId" | "blockerThreadId">>,
  threadId: ThreadId,
  blockerThreadId: ThreadId,
) => wouldCreateThreadWaitCycle(waits, threadId, blockerThreadId);

/** The wait `threadId` is snoozed on, if any. */
export const waitingOn = (waits: ReadonlyArray<ThreadWait>, threadId: ThreadId) =>
  waits.find((wait) => wait.threadId === threadId) ?? null;

/** How many threads wait on `threadId`. */
export const blockingCount = (waits: ReadonlyArray<ThreadWait>, threadId: ThreadId) =>
  waits.reduce((count, wait) => (wait.blockerThreadId === threadId ? count + 1 : count), 0);

export interface ThreadWaitIndex {
  readonly waits: ReadonlyArray<ThreadWait>;
  readonly waitingOn: (threadId: ThreadId) => ThreadWait | null;
  readonly blockingCount: (threadId: ThreadId) => number;
}

/** Constant-time lookups for rendering many rows from one list. */
export function indexThreadWaits(waits: ReadonlyArray<ThreadWait>): ThreadWaitIndex {
  const byThread = new Map(waits.map((wait) => [wait.threadId, wait]));
  const counts = new Map<ThreadId, number>();
  for (const wait of waits) {
    counts.set(wait.blockerThreadId, (counts.get(wait.blockerThreadId) ?? 0) + 1);
  }
  return {
    waits,
    waitingOn: (threadId) => byThread.get(threadId) ?? null,
    blockingCount: (threadId) => counts.get(threadId) ?? 0,
  };
}

const EMPTY_INDEX = indexThreadWaits([]);

/**
 * `serverConfigsAtom` is the client's per-environment server config map (web:
 * `environmentPresentations.serverConfigsAtom`). `waits` streams the full list live;
 * `index` is the same list as lookups, empty while unsupported or still loading.
 */
export function createThreadWaitEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ThreadWaitCapabilityConfig>>,
) {
  const waits = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:thread-waits:subscribe",
    tag: THREAD_WAIT_WS_METHODS.subscribe,
  });
  const supported = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => supportsThreadWaits(get(serverConfigsAtom).get(environmentId))).pipe(
      Atom.withLabel(`thread-waits:supported:${environmentId}`),
    ),
  );
  const index = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      if (!get(supported(environmentId))) return EMPTY_INDEX;
      const list = AsyncResult.value(get(waits({ environmentId, input: {} })));
      return Option.isSome(list) ? indexThreadWaits(list.value.waits) : EMPTY_INDEX;
    }).pipe(Atom.withLabel(`thread-waits:index:${environmentId}`)),
  );
  return {
    supported,
    waits,
    index,
    /** Snoozes `threadId` until `blockerThreadId` is done; the server checks cycles too. */
    setThreadWait: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-waits:set",
      tag: THREAD_WAIT_WS_METHODS.set,
    }),
    /** Drops the wait; `wake: true` also unsnoozes the thread ("Stop waiting"). */
    clearThreadWait: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-waits:clear",
      tag: THREAD_WAIT_WS_METHODS.clear,
    }),
  };
}
