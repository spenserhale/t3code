import { assert, describe, it } from "@effect/vitest";
import type { SecretRelayStreamItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SecretRelay from "./SecretRelay.ts";

const loginAsk = {
  kind: "login",
  threadId: "thread-a",
  origin: "https://grafana.example.com",
} as const;

/** Subscribes for `kinds`, collecting what arrives. */
const subscriber = (relay: SecretRelay.SecretRelay["Service"], kinds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<SecretRelayStreamItem>();
    yield* relay.subscribe(kinds).pipe(
      Stream.runForEach((item) => Queue.offer(items, item)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return items;
  });

const takeRequest = (items: Queue.Queue<SecretRelayStreamItem>) =>
  Queue.take(items).pipe(
    Effect.map((item) => {
      if (item.type !== "request") throw new Error(`Expected a request, got ${item.type}.`);
      return item.request;
    }),
  );

describe("SecretRelay", () => {
  it.effect("refuses at once when no subscriber answers that kind", () =>
    Effect.gen(function* () {
      const relay = yield* SecretRelay.SecretRelay;
      const nobody = yield* relay.request(loginAsk, 60_000).pipe(Effect.flip);
      assert.strictEqual(nobody.reason, "no_device");
      // Kinds this server does not know are ignored, not mistaken for logins.
      yield* subscriber(relay, ["identity", "card"]);
      const wrongKind = yield* relay.request(loginAsk, 60_000).pipe(Effect.flip);
      assert.strictEqual(wrongKind.reason, "no_device");
    }).pipe(Effect.scoped, Effect.provide(SecretRelay.layer)),
  );

  it.effect(
    "sends a request only to its kind's subscribers, waiting ones first, and the first answer wins",
    () =>
      Effect.gen(function* () {
        const relay = yield* SecretRelay.SecretRelay;
        const early = yield* subscriber(relay, ["login", "card"]);
        const identities = yield* subscriber(relay, ["identity"]);
        const call = yield* relay.request(loginAsk, 60_000).pipe(Effect.forkScoped);
        const asked = yield* takeRequest(early);
        assert.deepStrictEqual(asked, {
          ...loginAsk,
          requestId: asked.requestId,
          expiresAt: 60_000,
        });
        // A device that connects while the request waits gets it on subscribing.
        const late = yield* subscriber(relay, ["login"]);
        assert.deepStrictEqual(yield* takeRequest(late), asked);

        const values = { password: Redacted.make("hunter2") };
        const item = {
          id: "device:work/g1",
          title: "Grafana",
          urls: ["https://grafana.example.com"],
        };
        yield* relay.answer(asked.requestId, { type: "values", item, values });
        yield* relay.answer(asked.requestId, { type: "denied" });
        yield* relay.answer("unknown", { type: "none" });
        assert.deepStrictEqual(yield* Fiber.join(call), { type: "values", item, values });
        for (const items of [early, late]) {
          assert.deepStrictEqual(yield* Queue.take(items), {
            type: "ended",
            requestId: asked.requestId,
          });
        }
        assert.strictEqual(yield* Queue.size(identities), 0);
      }).pipe(Effect.scoped, Effect.provide(SecretRelay.layer)),
  );

  it.effect("ends a request nobody answers by its deadline, and one whose call ended", () =>
    Effect.gen(function* () {
      const relay = yield* SecretRelay.SecretRelay;
      const items = yield* subscriber(relay, ["login"]);

      const unanswered = yield* relay
        .request(loginAsk, 30_000)
        .pipe(Effect.flip, Effect.forkScoped);
      const first = yield* takeRequest(items);
      yield* TestClock.adjust(30_000);
      assert.strictEqual((yield* Fiber.join(unanswered)).reason, "timeout");
      assert.deepStrictEqual(yield* Queue.take(items), {
        type: "ended",
        requestId: first.requestId,
      });
      // An answer after the end changes nothing.
      yield* relay.answer(first.requestId, { type: "none" });

      const abandoned = yield* relay.request(loginAsk, 30_000).pipe(Effect.forkScoped);
      const second = yield* takeRequest(items);
      yield* Fiber.interrupt(abandoned);
      assert.deepStrictEqual(yield* Queue.take(items), {
        type: "ended",
        requestId: second.requestId,
      });
      // Nothing waits any more, so a new subscriber gets nothing.
      const after = yield* subscriber(relay, ["login"]);
      assert.strictEqual(yield* Queue.size(after), 0);
    }).pipe(Effect.scoped, Effect.provide(SecretRelay.layer)),
  );
});
