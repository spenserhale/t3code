// @effect-diagnostics nodeBuiltinImport:off - rows live in the synchronous sidebar store.
/**
 * Snooze a thread until another one is done. A wait is a row in `sidebar.sqlite`; the snooze
 * itself is upstream's `thread.snooze`, one year out, so official clients see a plain snooze.
 * The blocker settling, being archived, or deleted wakes the waiting thread with `thread.unsnooze`.
 * A wait whose thread is no longer snoozed to the exact time it set is dropped without waking.
 */
import type * as NodeSqlite from "node:sqlite";

import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadWait,
  ThreadWaitError,
  type ThreadWaitClearInput,
  type ThreadWaitList,
  type ThreadWaitSetInput,
  wouldCreateThreadWaitCycle,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { SidebarStore } from "../sidebar/SidebarStore.ts";

export type ThreadWaitThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "archivedAt" | "deletedAt" | "settledOverride" | "snoozedUntil"
>;

class ThreadWaitRuntimeError extends Data.TaggedError("ThreadWaitRuntimeError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const runtimeError = (message: string) => (cause: unknown) =>
  new ThreadWaitRuntimeError({ message: `${message}: ${messageOf(cause)}`, cause });

/** What the service needs from orchestration; tests pass fakes. */
export interface ThreadWaitRuntime {
  /** The thread as projected now, or null when it does not exist. */
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadWaitThread | null, ThreadWaitRuntimeError>;
  readonly dispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<unknown, ThreadWaitRuntimeError>;
  /** Ids of threads that changed, after the change is projected. */
  readonly threadChanges: Stream.Stream<ThreadId, ThreadWaitRuntimeError>;
}

export class ThreadWaits extends Context.Service<
  ThreadWaits,
  {
    readonly list: Effect.Effect<ThreadWaitList>;
    /** The current list, then the list after every change. */
    readonly changes: Stream.Stream<ThreadWaitList>;
    readonly set: (input: ThreadWaitSetInput) => Effect.Effect<ThreadWait, ThreadWaitError>;
    readonly clear: (input: ThreadWaitClearInput) => Effect.Effect<void, ThreadWaitError>;
    /** Re-checks the waits that involve `threadId`. */
    readonly observe: (threadId: ThreadId) => Effect.Effect<void>;
    /** Re-checks every wait, for a run that may have missed changes. */
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/threadWaits/ThreadWaits") {}

const WAIT_DURATION = { days: 365 } as const;

const isDone = (thread: ThreadWaitThread | null) =>
  thread === null ||
  thread.deletedAt !== null ||
  thread.archivedAt !== null ||
  thread.settledOverride === "settled";

const isHeldBy = (thread: ThreadWaitThread | null, wait: ThreadWait) =>
  thread !== null &&
  !isDone(thread) &&
  thread.snoozedUntil != null &&
  DateTime.toEpochMillis(thread.snoozedUntil) === Date.parse(wait.snoozedUntil);

const readRows = (database: NodeSqlite.DatabaseSync): ReadonlyArray<ThreadWait> =>
  database
    .prepare(
      `SELECT thread_id, blocker_thread_id, snoozed_until, created_at
       FROM thread_waits ORDER BY created_at, thread_id`,
    )
    .all()
    .map((row) => ({
      threadId: String(row["thread_id"]) as ThreadId,
      blockerThreadId: String(row["blocker_thread_id"]) as ThreadId,
      snoozedUntil: String(row["snoozed_until"]),
      createdAt: String(row["created_at"]),
    }));

const messageOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String(cause.message)
    : String(cause);

export const make = Effect.fn("ThreadWaits.make")(function* (runtime: ThreadWaitRuntime) {
  const store = yield* SidebarStore;
  const waits = yield* SubscriptionRef.make<ReadonlyArray<ThreadWait>>([]);
  const lock = yield* Semaphore.make(1);

  const database = store.database.pipe(Effect.map(Option.getOrNull));
  const publish = (db: NodeSqlite.DatabaseSync) =>
    Effect.suspend(() => SubscriptionRef.set(waits, readRows(db)));
  const loaded = yield* Effect.cached(
    database.pipe(Effect.flatMap((db) => (db === null ? Effect.void : publish(db)))),
  );
  const current = Effect.andThen(loaded, SubscriptionRef.get(waits));
  const remove = (db: NodeSqlite.DatabaseSync, threadId: ThreadId) =>
    Effect.sync(() =>
      db.prepare("DELETE FROM thread_waits WHERE thread_id = ?").run(threadId),
    ).pipe(Effect.andThen(publish(db)));

  const failure = (reason: ThreadWaitError["reason"], message: string) =>
    new ThreadWaitError({ reason, message });

  const readThread = (threadId: ThreadId) =>
    runtime
      .readThread(threadId)
      .pipe(Effect.mapError((error) => failure("unavailable", error.message)));

  // Reads both threads fresh: an event's payload can predate a wait set since it was emitted.
  const evaluate = Effect.fn("ThreadWaits.evaluate")(function* (
    db: NodeSqlite.DatabaseSync,
    wait: ThreadWait,
  ) {
    const waiting = yield* readThread(wait.threadId);
    if (!isHeldBy(waiting, wait)) return yield* remove(db, wait.threadId);
    if (!isDone(yield* readThread(wait.blockerThreadId))) return;
    yield* runtime.dispatch({
      type: "thread.unsnooze",
      commandId: CommandId.make(`thread-wait:wake:${wait.threadId}:${wait.createdAt}`),
      threadId: wait.threadId,
      reason: "user",
    });
    yield* remove(db, wait.threadId);
  });

  const evaluateAll = (db: NodeSqlite.DatabaseSync, selected: ReadonlyArray<ThreadWait>) =>
    Effect.forEach(
      selected,
      (wait) =>
        evaluate(db, wait).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread-waits.evaluate-failed", { threadId: wait.threadId, cause }),
          ),
        ),
      { discard: true },
    );

  const withDatabase = (use: (db: NodeSqlite.DatabaseSync) => Effect.Effect<void>) =>
    database.pipe(Effect.flatMap((db) => (db === null ? Effect.void : use(db))));

  const involves = (threadId: ThreadId) => (wait: ThreadWait) =>
    wait.threadId === threadId || wait.blockerThreadId === threadId;

  // Waits are re-read under the lock: a `set` may have replaced one since the change was seen.
  const observe = Effect.fn("ThreadWaits.observe")(function* (threadId: ThreadId) {
    if (!(yield* current).some(involves(threadId))) return;
    yield* lock.withPermit(
      withDatabase((db) =>
        Effect.suspend(() => evaluateAll(db, readRows(db).filter(involves(threadId)))),
      ),
    );
  });

  const reconcile = lock
    .withPermit(
      withDatabase((db) =>
        Effect.andThen(
          loaded,
          Effect.suspend(() => evaluateAll(db, readRows(db))),
        ),
      ),
    )
    .pipe(Effect.withSpan("ThreadWaits.reconcile"));

  const requireDatabase = database.pipe(
    Effect.filterOrFail(
      (db): db is NodeSqlite.DatabaseSync => db !== null,
      () => failure("unavailable", "The sidebar store is unavailable on this server."),
    ),
  );

  const set = Effect.fn("ThreadWaits.set")(function* (input: ThreadWaitSetInput) {
    const { threadId, blockerThreadId } = input;
    if (threadId === blockerThreadId) {
      return yield* failure("self", "A thread cannot wait on itself.");
    }
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const db = yield* requireDatabase;
        yield* loaded;
        if (wouldCreateThreadWaitCycle(readRows(db), threadId, blockerThreadId)) {
          return yield* failure("cycle", "That thread already waits on this one.");
        }
        const waiting = yield* readThread(threadId);
        if (waiting === null || waiting.deletedAt !== null) {
          return yield* failure("thread-not-found", `Thread ${threadId} does not exist.`);
        }
        if (isDone(waiting)) {
          return yield* failure("thread-inactive", "Settled or archived threads cannot wait.");
        }
        const blocker = yield* readThread(blockerThreadId);
        if (blocker === null || blocker.deletedAt !== null) {
          return yield* failure("blocker-not-found", `Thread ${blockerThreadId} does not exist.`);
        }
        if (isDone(blocker)) {
          return yield* failure("blocker-inactive", "That thread is already settled or archived.");
        }
        const now = yield* DateTime.now;
        const wait: ThreadWait = {
          threadId,
          blockerThreadId,
          snoozedUntil: DateTime.formatIso(DateTime.add(now, WAIT_DURATION)),
          createdAt: DateTime.formatIso(now),
        };
        yield* runtime
          .dispatch({
            type: "thread.snooze",
            commandId: CommandId.make(`thread-wait:snooze:${threadId}:${wait.createdAt}`),
            threadId,
            snoozedUntil: wait.snoozedUntil,
          })
          .pipe(Effect.mapError((error) => failure("snooze-failed", error.message)));
        db.prepare(
          `INSERT INTO thread_waits (thread_id, blocker_thread_id, snoozed_until, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (thread_id) DO UPDATE SET
             blocker_thread_id = excluded.blocker_thread_id,
             snoozed_until = excluded.snoozed_until,
             created_at = excluded.created_at`,
        ).run(wait.threadId, wait.blockerThreadId, wait.snoozedUntil, wait.createdAt);
        yield* publish(db);
        return wait;
      }),
    );
  });

  const clear = Effect.fn("ThreadWaits.clear")(function* (input: ThreadWaitClearInput) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        const db = yield* requireDatabase;
        const existing = readRows(db).some((wait) => wait.threadId === input.threadId);
        yield* remove(db, input.threadId);
        if (!existing || !input.wake) return;
        const now = yield* DateTime.now;
        yield* runtime
          .dispatch({
            type: "thread.unsnooze",
            commandId: CommandId.make(
              `thread-wait:stop:${input.threadId}:${DateTime.formatIso(now)}`,
            ),
            threadId: input.threadId,
            reason: "user",
          })
          .pipe(Effect.mapError((error) => failure("wake-failed", error.message)));
      }),
    );
  });

  return ThreadWaits.of({
    list: Effect.map(current, (list) => ({ waits: list })),
    changes: Stream.unwrap(
      Effect.as(
        loaded,
        SubscriptionRef.changes(waits).pipe(Stream.map((list) => ({ waits: list }))),
      ),
    ),
    set,
    clear,
    observe,
    reconcile,
  });
});

/** Follows thread changes and reconciles once the server is active. */
export const start = Effect.fn("ThreadWaits.start")(function* (
  service: ThreadWaits["Service"],
  threadChanges: ThreadWaitRuntime["threadChanges"],
) {
  yield* forkParked(
    Stream.runForEach(threadChanges, service.observe).pipe(
      Effect.catchCause((cause) => Effect.logWarning("thread-waits.follow-failed", { cause })),
    ),
  );
  yield* forkParked(service.reconcile);
});

export const layer = Layer.effect(
  ThreadWaits,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const runtime: ThreadWaitRuntime = {
      readThread: (threadId) =>
        projections
          .getThreadShell(threadId)
          .pipe(Effect.mapError(runtimeError(`Could not read thread ${threadId}`))),
      dispatch: (command) =>
        threads.dispatch(command).pipe(Effect.mapError(runtimeError(`${command.type} failed`))),
      threadChanges: orchestrator.streamDomainEvents.pipe(
        Stream.filter((event) => event.type.startsWith("thread.")),
        Stream.map((event) => event.threadId),
        Stream.mapError(runtimeError("Thread changes stopped")),
      ),
    };
    const service = yield* make(runtime);
    yield* start(service, runtime.threadChanges);
    return service;
  }),
);
