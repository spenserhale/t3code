import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeSingleFlight, ReadFailed, retryDelayMs } from "./ollamaCloudThrottle.ts";

describe("retryDelayMs", () => {
  it("reads Retry-After as seconds or as a date, within bounds, else waits a minute", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    assert.strictEqual(retryDelayMs("600", now), 600_000);
    assert.strictEqual(retryDelayMs(" 1.5 ", now), 1_500);
    assert.strictEqual(retryDelayMs("Mon, 02 Nov 2026 10:05:00 GMT", now), 300_000);
    // Too little to be a pause, too much to trust.
    assert.strictEqual(retryDelayMs("0", now), 1_000);
    assert.strictEqual(retryDelayMs("Mon, 02 Nov 2026 09:00:00 GMT", now), 1_000);
    assert.strictEqual(retryDelayMs("86400", now), 3_600_000);
    for (const missing of [undefined, "", "  ", "soon"]) {
      assert.strictEqual(retryDelayMs(missing, now), 60_000);
    }
  });
});

describe("makeSingleFlight", () => {
  /** A read that takes ten seconds, counting how often it runs. */
  const slowRead = (runs: { count: number }, outcome: Effect.Effect<string, string>) =>
    Effect.sync(() => {
      runs.count += 1;
    }).pipe(Effect.andThen(Effect.sleep("10 seconds")), Effect.andThen(outcome));

  it.effect("shares one read among callers for a credential, and reads again once it is done", () =>
    Effect.gen(function* () {
      const flight = makeSingleFlight<string>();
      const runs = { count: 0 };
      const read = slowRead(runs, Effect.succeed("result"));

      const owner = yield* flight("key", read).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const joiner = yield* flight("key", read).pipe(Effect.forkChild);
      const other = yield* flight("other-key", Effect.succeed("other")).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("8 seconds");

      assert.deepStrictEqual(
        [yield* Fiber.join(owner), yield* Fiber.join(joiner), yield* Fiber.join(other)],
        ["result", "result", "other"],
      );
      assert.strictEqual(runs.count, 1);
      assert.strictEqual(yield* flight("key", Effect.succeed("later")), "later");
    }),
  );

  it.effect("fails every caller when the read fails, and reads fresh the next time", () =>
    Effect.gen(function* () {
      const flight = makeSingleFlight<string>();
      const read = slowRead({ count: 0 }, Effect.fail("boom"));

      const owner = yield* flight("key", read).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const joiner = yield* flight("key", read).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("8 seconds");

      for (const fiber of [owner, joiner]) {
        assert.instanceOf(yield* Effect.flip(Fiber.join(fiber)), ReadFailed);
      }
      assert.strictEqual(yield* flight("key", Effect.succeed("fresh")), "fresh");
    }),
  );

  it.effect("fails, rather than interrupts, the callers of a read that was cut short", () =>
    Effect.gen(function* () {
      const flight = makeSingleFlight<string>();
      const read = slowRead({ count: 0 }, Effect.succeed("unused"));

      const owner = yield* flight("key", read).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const joiner = yield* flight("key", read).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");

      yield* Fiber.interrupt(owner);
      assert.instanceOf(yield* Effect.flip(Fiber.join(joiner)), ReadFailed);
      assert.strictEqual(yield* flight("key", Effect.succeed("fresh")), "fresh");
    }),
  );
});
