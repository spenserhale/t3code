/**
 * Secret requests this server cannot answer itself, relayed to the user's device. A client with a
 * desktop app subscribes for the kinds it can answer, has its own server ask the user and read the
 * item, and answers here. Every subscriber sees a request; the first answer counts.
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

export class SecretRelay extends Context.Service<
  SecretRelay,
  {
    /**
     * Requests of the kinds named that are waiting, then new ones, and `ended` once each is
     * answered or its call ends. Kinds this server does not know are ignored.
     */
    readonly subscribe: (kinds: ReadonlyArray<string>) => Stream.Stream<SecretRelayStreamItem>;
    /** The first answer to a request wins; a later or unknown one is ignored. */
    readonly answer: (requestId: string, answer: SecretRelayAnswer) => Effect.Effect<void>;
    /** Fails at once when no subscriber answers this kind, and when no answer comes in time. */
    readonly request: (
      ask: SecretRelayAsk,
      timeoutMs: number,
    ) => Effect.Effect<SecretRelayAnswer, SecretRelayError>;
  }
>()("t3/secrets/SecretRelay") {}

interface Subscriber {
  readonly kinds: ReadonlySet<SecretRelayKind>;
  readonly queue: Queue.Queue<SecretRelayStreamItem, Cause.Done>;
}

const isKind = Schema.is(SecretRelayKind);

const make = () => {
  const subscribers = new Set<Subscriber>();
  const pending = new Map<
    string,
    { readonly request: SecretRelayRequest; readonly answer: Deferred.Deferred<SecretRelayAnswer> }
  >();
  const send = (kind: SecretRelayKind, item: SecretRelayStreamItem) => {
    for (const subscriber of subscribers) {
      if (subscriber.kinds.has(kind)) Queue.offerUnsafe(subscriber.queue, item);
    }
  };

  // Registering and sending what waits happen in one step, so a request is neither missed nor
  // sent twice to a subscriber that joins while it is made.
  const subscribe: SecretRelay["Service"]["subscribe"] = (kinds) =>
    Stream.callback<SecretRelayStreamItem>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const subscriber: Subscriber = { kinds: new Set(kinds.filter(isKind)), queue };
          subscribers.add(subscriber);
          for (const { request } of pending.values()) {
            if (subscriber.kinds.has(request.kind)) {
              Queue.offerUnsafe(queue, { type: "request", request });
            }
          }
          return subscriber;
        }),
        (subscriber) => Effect.sync(() => subscribers.delete(subscriber)),
      ),
    );

  const answer: SecretRelay["Service"]["answer"] = Effect.fn("SecretRelay.answer")(
    function* (requestId, answer) {
      const waiting = pending.get(requestId);
      if (waiting !== undefined) yield* Deferred.succeed(waiting.answer, answer);
    },
  );

  const request: SecretRelay["Service"]["request"] = Effect.fn("SecretRelay.request")(
    function* (ask, timeoutMs) {
      yield* Effect.annotateCurrentSpan({ "secret_relay.kind": ask.kind });
      if (![...subscribers].some((subscriber) => subscriber.kinds.has(ask.kind))) {
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
        pending.set(requestId, { request: relayed, answer: answered });
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
