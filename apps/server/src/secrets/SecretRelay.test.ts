import { assert, describe, it } from "@effect/vitest";
import type { SecretRelayAnswer, SecretRelayStreamItem } from "@t3tools/contracts";
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

/** A device subscribing for `kinds`, collecting what arrives until it leaves. */
const subscriber = (
  relay: SecretRelay.SecretRelay["Service"],
  kinds: ReadonlyArray<string>,
  device = "laptop",
) =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<SecretRelayStreamItem>();
    const subscription = yield* relay.subscribe(kinds, device).pipe(
      Stream.runForEach((item) => Queue.offer(items, item)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return { items, leave: Fiber.interrupt(subscription) };
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
    "sends a request only to its kind's subscribers, waiting ones first, and values end it at once",
    () =>
      Effect.gen(function* () {
        const relay = yield* SecretRelay.SecretRelay;
        const { items: early } = yield* subscriber(relay, ["login", "card"]);
        const { items: identities } = yield* subscriber(relay, ["identity"], "phone");
        const call = yield* relay.request(loginAsk, 60_000).pipe(Effect.forkScoped);
        const asked = yield* takeRequest(early);
        assert.deepStrictEqual(asked, {
          ...loginAsk,
          requestId: asked.requestId,
          expiresAt: 60_000,
        });
        // A device that connects while the request waits gets it on subscribing.
        const { items: late } = yield* subscriber(relay, ["login"], "desktop");
        assert.deepStrictEqual(yield* takeRequest(late), asked);

        const values = { password: Redacted.make("hunter2") };
        const item = {
          id: "device:work/g1",
          title: "Grafana",
          urls: ["https://grafana.example.com"],
        };
        yield* relay.answer(asked.requestId, { type: "values", item, values }, "laptop");
        yield* relay.answer(asked.requestId, { type: "denied" }, "desktop");
        yield* relay.answer("unknown", { type: "none" }, "laptop");
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

  it.effect(
    "ends a request on nothing found only once every device asked has answered or left",
    () =>
      Effect.gen(function* () {
        const relay = yield* SecretRelay.SecretRelay;
        const laptop = yield* subscriber(relay, ["login"]);
        const desktop = yield* subscriber(relay, ["login"], "desktop");
        const ask = (accepts?: Parameters<typeof relay.request>[2]) =>
          Effect.gen(function* () {
            const call = yield* relay.request(loginAsk, 60_000, accepts).pipe(Effect.forkScoped);
            const { requestId } = yield* takeRequest(laptop.items);
            const answer = (device: string, answer: SecretRelayAnswer) =>
              relay.answer(requestId, answer, device);
            const result = Fiber.join(call).pipe(
              Effect.tap(() =>
                Queue.take(laptop.items).pipe(
                  Effect.map((item) => assert.deepStrictEqual(item, { type: "ended", requestId })),
                ),
              ),
            );
            return { answer, result };
          });
        const locked = { type: "unavailable", message: "1Password is locked." } as const;

        // A refusal does not wait for the laptop.
        const refused = yield* ask();
        yield* refused.answer("desktop", { type: "denied" });
        assert.deepStrictEqual(yield* refused.result, { type: "denied" });

        // A quick "none" on the laptop does not beat the user allowing on the desktop.
        const allowed = yield* ask();
        yield* allowed.answer("laptop", { type: "none" });
        const choose = { type: "choose", candidates: [] } as const;
        yield* allowed.answer("desktop", choose);
        assert.deepStrictEqual(yield* allowed.result, choose);

        const missing = yield* ask();
        yield* missing.answer("laptop", locked);
        yield* missing.answer("desktop", { type: "none" });
        assert.deepStrictEqual(yield* missing.result, { type: "none" });

        const unavailable = yield* ask();
        yield* unavailable.answer("laptop", locked);
        yield* unavailable.answer("desktop", { type: "unavailable", message: "No app." });
        assert.deepStrictEqual(yield* unavailable.result, locked);

        // Values the caller does not accept, such as a login without the one-time code asked
        // for, are that device finding nothing: the desktop's request stays open.
        const login = (values: Readonly<Record<string, string>>): SecretRelayAnswer => ({
          type: "values",
          item: { id: "device:work/g1", title: "Grafana", urls: ["https://grafana.example.com"] },
          values: Object.fromEntries(
            Object.entries(values).map(([field, value]) => [field, Redacted.make(value)]),
          ),
        });
        const withCode = login({ password: "hunter2", totp: "123456" });
        const lacking = yield* ask((answer) => "totp" in answer.values);
        yield* lacking.answer("laptop", login({ password: "hunter2" }));
        yield* lacking.answer("desktop", withCode);
        assert.deepStrictEqual(yield* lacking.result, withCode);
        const neither = yield* ask((answer) => "totp" in answer.values);
        yield* neither.answer("laptop", login({ password: "hunter2" }));
        yield* neither.answer("desktop", locked);
        assert.deepStrictEqual(yield* neither.result, { type: "none" });

        // A device is still waited for while another of its subscriptions has the kind, as
        // after a reconnect.
        const reconnected = yield* subscriber(relay, ["login"], "desktop");
        const reconnecting = yield* ask();
        yield* reconnecting.answer("laptop", { type: "none" });
        yield* desktop.leave;
        yield* reconnecting.answer("desktop", choose);
        assert.deepStrictEqual(yield* reconnecting.result, choose);

        // Once it has none left, the laptop's answer stands.
        const leaving = yield* ask();
        yield* leaving.answer("laptop", { type: "none" });
        yield* reconnected.leave;
        assert.deepStrictEqual(yield* leaving.result, { type: "none" });
      }).pipe(Effect.scoped, Effect.provide(SecretRelay.layer)),
  );

  it.effect("ends a request nobody answers by its deadline, and one whose call ended", () =>
    Effect.gen(function* () {
      const relay = yield* SecretRelay.SecretRelay;
      const { items } = yield* subscriber(relay, ["login"]);

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
      yield* relay.answer(first.requestId, { type: "none" }, "laptop");

      const abandoned = yield* relay.request(loginAsk, 30_000).pipe(Effect.forkScoped);
      const second = yield* takeRequest(items);
      yield* Fiber.interrupt(abandoned);
      assert.deepStrictEqual(yield* Queue.take(items), {
        type: "ended",
        requestId: second.requestId,
      });
      // Nothing waits any more, so a new subscriber gets nothing.
      const after = yield* subscriber(relay, ["login"]);
      assert.strictEqual(yield* Queue.size(after.items), 0);
    }).pipe(Effect.scoped, Effect.provide(SecretRelay.layer)),
  );
});
