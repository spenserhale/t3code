import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationV2Command, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as SidebarStore from "../sidebar/SidebarStore.ts";
import * as ThreadWaits from "./ThreadWaits.ts";

const A = ThreadId.make("thread-a");
const B = ThreadId.make("thread-b");
const C = ThreadId.make("thread-c");
const D = ThreadId.make("thread-d");

const active = (id: ThreadId): ThreadWaits.ThreadWaitThread => ({
  id,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  snoozedUntil: null,
});

/** Threads the fake orchestrator projects; snooze commands change them like the real one. */
const makeRuntime = Effect.gen(function* () {
  const threads = new Map([A, B, C, D].map((id) => [id, active(id)]));
  const dispatched: Array<OrchestrationV2Command> = [];
  const changes = yield* Queue.unbounded<ThreadId>();
  const runtime: ThreadWaits.ThreadWaitRuntime = {
    readThread: (threadId) => Effect.sync(() => threads.get(threadId) ?? null),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type !== "thread.snooze" && command.type !== "thread.unsnooze") return;
        const thread = threads.get(command.threadId);
        if (thread === undefined) return;
        if (command.type === "thread.snooze") {
          threads.set(thread.id, {
            ...thread,
            snoozedUntil: DateTime.makeUnsafe(command.snoozedUntil),
          });
        } else {
          threads.set(thread.id, { ...thread, snoozedUntil: null });
        }
      }),
    threadChanges: Stream.fromQueue(changes),
  };
  const update = (id: ThreadId, patch: Partial<ThreadWaits.ThreadWaitThread>) => {
    threads.set(id, { ...threads.get(id)!, ...patch });
  };
  return { runtime, threads, dispatched, changes, update };
});

const unsnoozed = (dispatched: ReadonlyArray<OrchestrationV2Command>) =>
  dispatched.flatMap((command) => (command.type === "thread.unsnooze" ? [command.threadId] : []));

const waitsOf = (service: ThreadWaits.ThreadWaits["Service"]) =>
  service.list.pipe(Effect.map((list) => list.waits.map((w) => [w.threadId, w.blockerThreadId])));

const layerUnavailable = Layer.succeed(
  SidebarStore.SidebarStore,
  SidebarStore.SidebarStore.of({ database: Effect.succeedNone }),
);

describe("ThreadWaits", () => {
  it.effect("snoozes the thread a year out and stores that exact time", () =>
    Effect.gen(function* () {
      const fake = yield* makeRuntime;
      const service = yield* ThreadWaits.make(fake.runtime);

      const wait = yield* service.set({ threadId: A, blockerThreadId: B });

      assert.strictEqual(wait.snoozedUntil, "1971-01-01T00:00:00.000Z");
      assert.deepStrictEqual(fake.dispatched, [
        {
          type: "thread.snooze",
          commandId: fake.dispatched[0]!.commandId,
          threadId: A,
          snoozedUntil: wait.snoozedUntil,
        },
      ]);
      assert.deepStrictEqual((yield* service.list).waits, [wait]);
    }).pipe(Effect.provide(SidebarStore.layerMemory)),
  );

  it.effect("refuses self, cycles, inactive or missing threads, and a missing store", () =>
    Effect.gen(function* () {
      const fake = yield* makeRuntime;
      const service = yield* ThreadWaits.make(fake.runtime);
      const reason = (threadId: ThreadId, blockerThreadId: ThreadId) =>
        service.set({ threadId, blockerThreadId }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      assert.strictEqual(yield* reason(A, A), "self");
      yield* service.set({ threadId: A, blockerThreadId: B });
      yield* service.set({ threadId: B, blockerThreadId: C });
      assert.strictEqual(yield* reason(C, A), "cycle");
      assert.strictEqual(yield* reason(B, A), "cycle");
      fake.update(C, { settledOverride: "settled" });
      assert.strictEqual(yield* reason(A, C), "blocker-inactive");
      fake.update(D, { archivedAt: DateTime.makeUnsafe(0) });
      assert.strictEqual(yield* reason(D, B), "thread-inactive");
      assert.strictEqual(yield* reason(A, ThreadId.make("missing")), "blocker-not-found");
      fake.update(D, { deletedAt: DateTime.makeUnsafe(0) });
      assert.strictEqual(yield* reason(D, B), "thread-not-found");
      assert.strictEqual(fake.dispatched.length, 2);

      const offline = yield* ThreadWaits.make(fake.runtime).pipe(Effect.provide(layerUnavailable));
      assert.strictEqual(
        yield* offline.set({ threadId: D, blockerThreadId: B }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        ),
        "unavailable",
      );
      assert.deepStrictEqual((yield* offline.list).waits, []);
    }).pipe(Effect.provide(SidebarStore.layerMemory)),
  );

  it.effect("wakes the waiting thread and drops the wait when the blocker settles", () =>
    Effect.gen(function* () {
      const fake = yield* makeRuntime;
      const service = yield* ThreadWaits.make(fake.runtime);
      yield* service.set({ threadId: A, blockerThreadId: B });
      yield* service.set({ threadId: C, blockerThreadId: B });
      yield* ThreadWaits.start(service, fake.runtime.threadChanges);
      const emptied = yield* service.changes.pipe(
        Stream.filter((list) => list.waits.length === 0),
        Stream.runHead,
        Effect.forkChild,
      );

      fake.update(B, { settledOverride: "settled" });
      yield* Queue.offer(fake.changes, B);
      yield* Fiber.join(emptied);

      assert.deepStrictEqual(unsnoozed(fake.dispatched), [A, C]);
      assert.isNull(fake.threads.get(A)!.snoozedUntil);
    }).pipe(Effect.scoped, Effect.provide(SidebarStore.layerMemory)),
  );

  it.effect("drops the wait without waking when the thread is snoozed elsewhere or settled", () =>
    Effect.gen(function* () {
      const fake = yield* makeRuntime;
      const service = yield* ThreadWaits.make(fake.runtime);
      yield* service.set({ threadId: A, blockerThreadId: B });
      yield* service.set({ threadId: C, blockerThreadId: B });

      fake.update(A, { snoozedUntil: DateTime.makeUnsafe("1970-01-02T00:00:00.000Z") });
      yield* service.observe(A);
      assert.deepStrictEqual(yield* waitsOf(service), [[C, B]]);

      fake.update(C, { settledOverride: "settled", snoozedUntil: null });
      fake.update(B, { archivedAt: DateTime.makeUnsafe(0) });
      yield* service.observe(B);
      assert.deepStrictEqual(yield* waitsOf(service), []);
      assert.deepStrictEqual(unsnoozed(fake.dispatched), []);
    }).pipe(Effect.provide(SidebarStore.layerMemory)),
  );

  it.effect("reconciles waits left by a run that missed the changes", () =>
    Effect.gen(function* () {
      const fake = yield* makeRuntime;
      const before = yield* ThreadWaits.make(fake.runtime);
      yield* before.set({ threadId: A, blockerThreadId: B });
      yield* before.set({ threadId: B, blockerThreadId: C });
      // While no server ran: C was deleted, and B was woken by hand.
      fake.update(C, { deletedAt: DateTime.makeUnsafe(0) });
      fake.update(B, { snoozedUntil: null });
      fake.dispatched.length = 0;

      const after = yield* ThreadWaits.make(fake.runtime);
      assert.deepStrictEqual(yield* waitsOf(after), [
        [A, B],
        [B, C],
      ]);
      yield* after.reconcile;

      assert.deepStrictEqual(yield* waitsOf(after), [[A, B]]);
      assert.deepStrictEqual(fake.dispatched, []);
    }).pipe(Effect.provide(SidebarStore.layerMemory)),
  );

  it.effect("clears a wait, waking the thread only when asked", () =>
    Effect.gen(function* () {
      const fake = yield* makeRuntime;
      const service = yield* ThreadWaits.make(fake.runtime);
      yield* service.set({ threadId: A, blockerThreadId: B });
      yield* service.set({ threadId: C, blockerThreadId: B });

      yield* service.clear({ threadId: A, wake: false });
      yield* service.clear({ threadId: C, wake: true });
      yield* service.clear({ threadId: B, wake: true });

      assert.deepStrictEqual(yield* waitsOf(service), []);
      assert.deepStrictEqual(unsnoozed(fake.dispatched), [C]);
      assert.isNotNull(fake.threads.get(A)!.snoozedUntil);
    }).pipe(Effect.provide(SidebarStore.layerMemory)),
  );
});
