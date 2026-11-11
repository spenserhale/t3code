/**
 * Secret requests this server cannot answer itself, relayed to the user's device. A client with a
 * desktop app subscribes for the kinds it can answer, has its own server ask the user and read the
 * item, and answers here. Every subscriber sees a request, unless it names an item one device
 * offered; and a quick `none` from one device must not beat the user allowing on another.
 */
import {
  SECRET_RELAY_DEVICE_PREFIX,
  type SecretRelayAnswer,
  SecretRelayKind,
  type SecretRelayRequest,
  type SecretRelayStreamItem,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class SecretRelayError extends Schema.TaggedError<SecretRelayError>()("SecretRelayError", {
  reason: Schema.Literals(["no_device", "timeout"]),
}) {
  override get message(): string {
    return this.reason === "no_device"
      ? "No device that can answer this request is connected."
      : "The user's device did not answer before the call ended.";
  }
}

/** A request as its caller makes it; the relay names it and sets when it expires. */
export type SecretRelayAsk = Omit<SecretRelayRequest, "requestId" | "expiresAt">;

export type SecretRelayValues = Extract<SecretRelayAnswer, { readonly type: "values" }>;

export class SecretRelay extends Context.Service<
  SecretRelay,
  {
    /**
     * Requests of the kinds named that are waiting, then new ones, and `ended` once each is
     * answered or its call ends. Kinds this server does not know are ignored. `device` names the
     * client, the same for its answers, so a request knows which devices it still waits for.
     */
    readonly subscribe: (
      kinds: ReadonlyArray<string>,
      device: string,
    ) => Stream.Stream<SecretRelayStreamItem>;
    /**
     * Values, a choice or a refusal end the request at once. `none` and `unavailable` end it once
     * every device subscribed for its kind when it started has answered or left: `none` if any
     * device said so. A late or unknown answer is ignored.
     */
    readonly answer: (
      requestId: string,
      answer: SecretRelayAnswer,
      device: string,
    ) => Effect.Effect<void>;
    /**
     * Fails at once when no subscriber answers this kind, and when no answer comes in time. Values
     * `accepts` turns down, as lacking what was asked, count as that device answering `none`. Items
     * come back under ids made here; a request naming one reaches only the device that offered it,
     * and finds no device when the id was not made here, is too old, or that device is gone.
     */
    readonly request: (
      ask: SecretRelayAsk,
      timeoutMs: number,
      accepts?: (answer: SecretRelayValues) => boolean,
    ) => Effect.Effect<SecretRelayAnswer, SecretRelayError>;
  }
>()("t3/secrets/SecretRelay") {}

interface Subscriber {
  readonly kinds: ReadonlySet<SecretRelayKind>;
  readonly device: string;
  readonly queue: Queue.Queue<SecretRelayStreamItem, Cause.Done>;
}

type Inconclusive = Extract<SecretRelayAnswer, { readonly type: "none" | "unavailable" }>;

interface Pending {
  readonly request: SecretRelayRequest;
  readonly answer: Deferred.Deferred<SecretRelayAnswer>;
  /** Devices subscribed for its kind when it started that have neither answered nor left. */
  readonly waiting: Set<string>;
  /** The one device asked, about an item it offered; absent when every subscriber is asked. */
  readonly device: string | undefined;
  readonly accepts: ((answer: SecretRelayValues) => boolean) | undefined;
  inconclusive: Inconclusive | undefined;
}

/** An item a device offered, kept under the id the agent has for it. */
interface Offer {
  readonly device: string;
  /** The device's own id for the item, sent back to it as it gave it. */
  readonly item: string;
  readonly at: number;
}

const OFFER_TTL_MS = 60 * 60_000;
const OFFER_LIMIT = 1_000;

const isKind = Schema.is(SecretRelayKind);

const make = () => {
  const subscribers = new Set<Subscriber>();
  const pending = new Map<string, Pending>();
  // By the agent's id, oldest offer first, and those ids by device and item.
  const offers = new Map<string, Offer>();
  const offerIds = new Map<string, string>();
  const offerKey = (device: string, item: string) => `${device}\u0000${item}`;

  /**
   * The id the agent gets for an item a device offered: `fresh`, or the one it already has. It
   * names neither the device's password manager nor its item, so only this server can route it.
   */
  const offer = (device: string, item: string, fresh: string, now: number) => {
    const key = offerKey(device, item);
    const id = offerIds.get(key) ?? fresh;
    // A blank id could not be sent back to its device, so its item stays nobody's.
    if (item.trim() === "") return id;
    offers.delete(id);
    offers.set(id, { device, item, at: now });
    offerIds.set(key, id);
    for (const [oldest, old] of offers) {
      if (offers.size <= OFFER_LIMIT && now - old.at < OFFER_TTL_MS) break;
      offers.delete(oldest);
      offerIds.delete(offerKey(old.device, old.item));
    }
    return id;
  };

  const hears = (subscriber: Subscriber, { request, device }: Pending) =>
    subscriber.kinds.has(request.kind) && (device === undefined || device === subscriber.device);
  const send = (about: Pending, item: SecretRelayStreamItem) => {
    for (const subscriber of subscribers) {
      if (hears(subscriber, about)) Queue.offerUnsafe(subscriber.queue, item);
    }
  };
  const devicesFor = (kind: SecretRelayKind) =>
    new Set(
      [...subscribers]
        .filter((subscriber) => subscriber.kinds.has(kind))
        .map((subscriber) => subscriber.device),
    );
  // Once nobody is left to wait for, what was heard is the answer. When every device left without
  // answering, the request waits on for one that reconnects or joins.
  const stopWaiting = (waiting: Pending, device: string) => {
    waiting.waiting.delete(device);
    if (waiting.waiting.size === 0 && waiting.inconclusive !== undefined) {
      Deferred.doneUnsafe(waiting.answer, Effect.succeed(waiting.inconclusive));
    }
  };

  // Registering and sending what waits happen in one step, so a request is neither missed nor
  // sent twice to a subscriber that joins while it is made.
  const subscribe: SecretRelay["Service"]["subscribe"] = (kinds, device) =>
    Stream.callback<SecretRelayStreamItem>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const subscriber: Subscriber = { kinds: new Set(kinds.filter(isKind)), device, queue };
          subscribers.add(subscriber);
          for (const waiting of pending.values()) {
            if (hears(subscriber, waiting)) {
              Queue.offerUnsafe(queue, { type: "request", request: waiting.request });
            }
          }
          return subscriber;
        }),
        (subscriber) =>
          Effect.sync(() => {
            subscribers.delete(subscriber);
            for (const kind of subscriber.kinds) {
              // The device left that kind only when none of its subscriptions still has it.
              if (devicesFor(kind).has(subscriber.device)) continue;
              for (const waiting of pending.values()) {
                if (waiting.request.kind === kind) stopWaiting(waiting, subscriber.device);
              }
            }
          }),
      ),
    );

  const answer: SecretRelay["Service"]["answer"] = Effect.fn("SecretRelay.answer")(
    function* (requestId, given, device) {
      yield* Effect.annotateCurrentSpan({ "secret_relay.answer": given.type });
      const waiting = pending.get(requestId);
      if (waiting === undefined || (yield* Deferred.isDone(waiting.answer))) return;
      // Asked of one device, a request takes no other's answer.
      if (waiting.device !== undefined && waiting.device !== device) return;
      const answer: SecretRelayAnswer =
        given.type === "values" && waiting.accepts?.(given) === false ? { type: "none" } : given;
      if (answer.type === "none" || answer.type === "unavailable") {
        if (answer.type === "none" || waiting.inconclusive === undefined) {
          waiting.inconclusive = answer;
        }
        stopWaiting(waiting, device);
        return;
      }
      if (answer.type === "denied") {
        yield* Deferred.succeed(waiting.answer, answer);
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      const offered = (item: string) =>
        Effect.map(randomUuidV4, (uuid) =>
          offer(device, item, `${SECRET_RELAY_DEVICE_PREFIX}${uuid}`, now),
        );
      yield* Deferred.succeed(
        waiting.answer,
        answer.type === "values"
          ? { ...answer, item: { ...answer.item, id: yield* offered(answer.item.id) } }
          : {
              ...answer,
              candidates: yield* Effect.forEach(answer.candidates, (candidate) =>
                Effect.map(offered(candidate.id), (id) => ({ ...candidate, id })),
              ),
            },
      );
    },
  );

  const request: SecretRelay["Service"]["request"] = Effect.fn("SecretRelay.request")(
    function* (ask, timeoutMs, accepts) {
      yield* Effect.annotateCurrentSpan({ "secret_relay.kind": ask.kind });
      const now = yield* Clock.currentTimeMillis;
      const subscribed = devicesFor(ask.kind);
      const offered = ask.item === undefined ? undefined : offers.get(ask.item);
      // An item goes back to the device that offered it and to no other, so never to a guess.
      const owner =
        offered !== undefined && now - offered.at < OFFER_TTL_MS && subscribed.has(offered.device)
          ? offered
          : undefined;
      const devices = ask.item === undefined ? subscribed : new Set(owner ? [owner.device] : []);
      if (devices.size === 0) {
        return yield* new SecretRelayError({ reason: "no_device" });
      }
      const requestId = yield* randomUuidV4;
      const relayed: SecretRelayRequest = {
        ...ask,
        ...(owner === undefined ? {} : { item: owner.item }),
        requestId,
        expiresAt: now + timeoutMs,
      };
      const answered = yield* Deferred.make<SecretRelayAnswer>();
      const waiting: Pending = {
        request: relayed,
        answer: answered,
        waiting: devices,
        device: owner?.device,
        accepts,
        inconclusive: undefined,
      };
      yield* Effect.sync(() => {
        pending.set(requestId, waiting);
        send(waiting, { type: "request", request: relayed });
      });
      return yield* Deferred.await(answered).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new SecretRelayError({ reason: "timeout" })),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(requestId);
            send(waiting, { type: "ended", requestId });
          }),
        ),
      );
    },
  );

  return SecretRelay.of({ subscribe, answer, request });
};

export const layer = Layer.sync(SecretRelay, make);
