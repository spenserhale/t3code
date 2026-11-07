/**
 * The `threadWaits.*` WebSocket handlers, spread into the handlers `ws.ts` serves. The service is
 * optional, so a runtime or suite without it still answers: no waits, and a clear error on writes.
 */
import {
  THREAD_WAIT_WS_METHODS,
  ThreadWaitError,
  type ThreadWaitClearInput,
  type ThreadWaitSetInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ThreadWaits } from "./ThreadWaits.ts";

const unavailable = new ThreadWaitError({
  reason: "unavailable",
  message: "This server does not keep thread waits.",
});

export const make = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ThreadWaits);
  return {
    [THREAD_WAIT_WS_METHODS.subscribe]: (_input: object) =>
      Option.match(service, {
        onNone: () => Stream.concat(Stream.make({ waits: [] }), Stream.never),
        onSome: (waits) => waits.changes,
      }),
    [THREAD_WAIT_WS_METHODS.set]: (input: ThreadWaitSetInput) =>
      Option.match(service, {
        onNone: () => Effect.fail(unavailable),
        onSome: (waits) => waits.set(input),
      }),
    [THREAD_WAIT_WS_METHODS.clear]: (input: ThreadWaitClearInput) =>
      Option.match(service, {
        onNone: () => Effect.fail(unavailable),
        onSome: (waits) => waits.clear(input),
      }),
  };
});
