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
        const answer = yield* Fiber.join(call);
        const id = answer.type === "values" ? answer.item.id : "";
        assert.deepStrictEqual(answer, { type: "values", item: { ...item, id }, values });
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
        const lacking = yield* ask((answer) => "totp" in answer.values);
        yield* lacking.answer("laptop", login({ password: "hunter2" }));
        yield* lacking.answer("desktop", login({ password: "hunter2", totp: "123456" }));
        const withCode = yield* lacking.result;
        assert.isTrue(withCode.type === "values" && "totp" in withCode.values);
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

  it.effect("asks only the device that offered an item about it, under an id made here", () =>
    Effect.gen(function* () {
      const relay = yield* SecretRelay.SecretRelay;
      // Both Macs have a password manager with the id "personal".
      const laptop = yield* subscriber(relay, ["login"]);
      const desktop = yield* subscriber(relay, ["login"], "desktop");
      const own = "device:personal/g1";
      const item = { id: own, title: "Grafana", urls: ["https://grafana.example.com"] };
      const ended = (items: Queue.Queue<SecretRelayStreamItem>, requestId: string) =>
        Queue.take(items).pipe(
          Effect.map((heard) => assert.deepStrictEqual(heard, { type: "ended", requestId })),
        );
      /** A choice the laptop offers everyone's request, as the caller gets it. */
      const offer = (candidates: ReadonlyArray<{ readonly id: string; readonly title: string }>) =>
        Effect.gen(function* () {
          const call = yield* relay.request(loginAsk, 60_000).pipe(Effect.forkScoped);
          const [{ requestId }] = yield* Effect.all([
            takeRequest(laptop.items),
            takeRequest(desktop.items),
          ]);
          yield* relay.answer(requestId, { type: "choose", candidates }, "laptop");
          const answer = yield* Fiber.join(call);
          if (answer.type !== "choose") throw new Error(`Expected a choice, got ${answer.type}.`);
          for (const { items } of [laptop, desktop]) yield* ended(items, requestId);
          return answer.candidates;
        });
      /** The laptop's request for an item under the agent's id for it. */
      const choose = (id: string) =>
        Effect.gen(function* () {
          const call = yield* relay
            .request({ ...loginAsk, item: id }, 60_000)
            .pipe(Effect.forkScoped);
          return { call, asked: yield* takeRequest(laptop.items) };
        });
      const refusal = (id: string) =>
        relay.request({ ...loginAsk, item: id }, 60_000).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      const offered = yield* offer([
        { id: own, title: "Grafana" },
        { id: "device:personal/g2", title: "Grafana staging" },
      ]);
      const [chosen = "", other = ""] = offered.map((candidate) => candidate.id);
      // The agent's ids name neither the password manager nor the item.
      assert.match(chosen, /^device:[0-9a-f-]{36}$/);
      assert.match(other, /^device:[0-9a-f-]{36}$/);
      assert.notStrictEqual(chosen, other);
      assert.deepStrictEqual(
        offered.map((candidate) => candidate.title),
        ["Grafana", "Grafana staging"],
      );

      // The laptop is asked for the item under its own id. The desktop is not asked, and its
      // Deny ends nothing.
      const { call, asked } = yield* choose(chosen);
      assert.strictEqual(asked.item, own);
      yield* relay.answer(asked.requestId, { type: "denied" }, "desktop");
      const values = { password: Redacted.make("hunter2") };
      yield* relay.answer(asked.requestId, { type: "values", item, values }, "laptop");
      // The item keeps the id the agent chose it by.
      assert.deepStrictEqual(yield* Fiber.join(call), {
        type: "values",
        item: { ...item, id: chosen },
        values,
      });
      yield* ended(laptop.items, asked.requestId);
      // An id not made here, such as a guess at a device's own, reaches no device.
      assert.strictEqual(yield* refusal(own), "no_device");

      // Only the newest thousand ids are kept. The desktop heard of nothing since the first
      // choice: the next it hears, inside `offer`, is this request for everyone.
      const many = yield* offer(
        Array.from({ length: 1_000 }, (_, index) => ({
          id: `device:personal/n${index}`,
          title: `Login ${index}`,
        })),
      );
      assert.strictEqual(yield* refusal(chosen), "no_device");
      const newest = many.at(-1)?.id ?? "";

      // With its device gone the item is nobody's, though the desktop is still there.
      yield* laptop.leave;
      assert.strictEqual(yield* refusal(newest), "no_device");
      // A device is its sign-in, so the item is its again once it reconnects.
      const back = yield* subscriber(relay, ["login"]);
      const again = yield* relay
        .request({ ...loginAsk, item: newest }, 60_000)
        .pipe(Effect.forkScoped);
      const reasked = yield* takeRequest(back.items);
      assert.strictEqual(reasked.item, "device:personal/n999");
      yield* relay.answer(reasked.requestId, { type: "none" }, "laptop");
      assert.deepStrictEqual(yield* Fiber.join(again), { type: "none" });
      // An id is kept an hour from when its item was last offered.
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(yield* refusal(newest), "no_device");
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
