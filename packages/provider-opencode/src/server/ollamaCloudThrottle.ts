import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/** Ollama recommends polling once a minute, and allows ten requests a minute for every device. */
const DEFAULT_RETRY_MS = 60_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60 * 60_000;

/** How long to leave Ollama alone after it asked for time, in seconds or as an HTTP date. */
export function retryDelayMs(retryAfter: string | undefined, nowMs: number): number {
  const text = retryAfter?.trim();
  if (!text) return DEFAULT_RETRY_MS;
  const delayMs = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - nowMs;
  return Number.isFinite(delayMs)
    ? Math.min(Math.max(delayMs, MIN_RETRY_MS), MAX_RETRY_MS)
    : DEFAULT_RETRY_MS;
}

/** A read that a caller was waiting on did not produce a result. */
export class ReadFailed extends Schema.TaggedError<ReadFailed>()("OllamaCloudReadFailed", {}) {}

/**
 * Runs one read at a time per credential: a caller that arrives while it runs waits for it and
 * shares its result, and a read that fails or is interrupted fails them all the same way.
 */
export function makeSingleFlight<A>() {
  let flight: { readonly key: string; readonly done: Deferred.Deferred<A, ReadFailed> } | undefined;
  return <E, R>(key: string, read: Effect.Effect<A, E, R>): Effect.Effect<A, ReadFailed, R> =>
    Effect.suspend(() => {
      if (flight?.key === key) return Deferred.await(flight.done);
      const mine = { key, done: Deferred.makeUnsafe<A, ReadFailed>() };
      flight = mine;
      return read.pipe(
        Effect.mapError(() => new ReadFailed()),
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            if (flight === mine) flight = undefined;
            return Deferred.done(
              mine.done,
              Exit.hasInterrupts(exit) ? Exit.fail(new ReadFailed()) : exit,
            );
          }),
        ),
      );
    });
}
