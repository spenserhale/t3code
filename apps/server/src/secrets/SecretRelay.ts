/**
 * Secret requests this server cannot answer itself, relayed to the user's device. A client with a
 * desktop app subscribes for the kinds it can answer, has its own server ask the user and read the
 * item, and answers here. Every subscriber sees a request, and a quick `none` from one device must
 * not beat the user allowing on another.
 */
import {
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
     * `accepts` turns down, as lacking what was asked, count as that device answering `none`.
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
  readonly accepts: ((answer: SecretRelayValues) => boolean) | undefined;
  inconclusive: Inconclusive | undefined;
}

const isKind = Schema.is(SecretRelayKind);

const make = () => {
  const subscribers = new Set<Subscriber>();
  const pending = new Map<string, Pending>();
  const send = (kind: SecretRelayKind, item: SecretRelayStreamItem) => {
    for (const subscriber of subscribers) {
      if (subscriber.kinds.has(kind)) Queue.offerUnsafe(subscriber.queue, item);
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
          for (const { request } of pending.values()) {
            if (subscriber.kinds.has(request.kind)) {
              Queue.offerUnsafe(queue, { type: "request", request });
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
      if (waiting === undefined) return;
      const answer: SecretRelayAnswer =
        given.type === "values" && waiting.accepts?.(given) === false ? { type: "none" } : given;
      if (answer.type === "none" || answer.type === "unavailable") {
        if (answer.type === "none" || waiting.inconclusive === undefined) {
          waiting.inconclusive = answer;
        }
        stopWaiting(waiting, device);
        return;
      }
      yield* Deferred.succeed(waiting.answer, answer);
    },
  );

  const request: SecretRelay["Service"]["request"] = Effect.fn("SecretRelay.request")(
    function* (ask, timeoutMs, accepts) {
      yield* Effect.annotateCurrentSpan({ "secret_relay.kind": ask.kind });
      const devices = devicesFor(ask.kind);
      if (devices.size === 0) {
        return yield* new SecretRelayError({ reason: "no_device" });
      }
      const requestId = yield* randomUuidV4;
      const relayed: SecretRelayRequest = {
        ...ask,
        requestId,
        expiresAt: (yield* Clock.currentTimeMillis) + timeoutMs,
      };
      const answered = yield* Deferred.make<SecretRelayAnswer>();
      yield* Effect.sync(() => {
        pending.set(requestId, {
          request: relayed,
          answer: answered,
          waiting: devices,
          accepts,
          inconclusive: undefined,
        });
        send(ask.kind, { type: "request", request: relayed });
      });
      return yield* Deferred.await(answered).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new SecretRelayError({ reason: "timeout" })),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(requestId);
            send(ask.kind, { type: "ended", requestId });
          }),
        ),
      );
    },
  );

  return SecretRelay.of({ subscribe, answer, request });
};

export const layer = Layer.sync(SecretRelay, make);
