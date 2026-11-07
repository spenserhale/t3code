import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import { buildMarketRates, parseZdrEndpoints, type ZdrPrices } from "./openRouterZdr.ts";
import type { RateTable } from "./usagePricing.ts";

const ZDR_ENDPOINTS_URL = "https://openrouter.ai/api/v1/endpoints/zdr";

const ZDR_CACHE_FILE_NAME = "openrouter-zdr-rates.json";
const ZDR_TTL_MS = 24 * 60 * 60 * 1000;
const ZDR_RETRY_FLOOR_MS = 10 * 60 * 1000;

// The cache keeps the medians, not the 1 MB list they come from.
const ZdrCacheFile = Schema.Struct({
  version: Schema.Literal(1),
  fetchedAtMs: Schema.Number,
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      promptUsd: Schema.Number,
      completionUsd: Schema.Number,
      cacheReadUsd: Schema.NullOr(Schema.Number),
    }),
  ),
});
const decodeZdrCache = Schema.decodeUnknownEffect(Schema.fromJsonString(ZdrCacheFile));
const encodeZdrCache = Schema.encodeEffect(Schema.fromJsonString(ZdrCacheFile));

export class OpenRouterZdrRates extends Context.Service<
  OpenRouterZdrRates,
  {
    /** The rates held now. Never waits; the first call starts keeping the list fresh in the background. */
    readonly current: Effect.Effect<RateTable>;
    /** Fetches the list now if it is missing or a day old, and waits for the attempt. */
    readonly refresh: Effect.Effect<void>;
    /** The rates held now, then each new set as the service comes to hold it. */
    readonly changes: Stream.Stream<RateTable>;
  }
>()("t3/usage/OpenRouterZdrRates") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const cachePath = path.join(config.stateDir, ZDR_CACHE_FILE_NAME);

  let fetchedAtMs: number | null = null;
  let lastFailedAtMs: number | null = null;
  const lock = yield* Semaphore.make(1);

  const isFresh = (now: number) =>
    fetchedAtMs !== null && now - fetchedAtMs >= 0 && now - fetchedAtMs < ZDR_TTL_MS;

  const readCache = fileSystem.readFileString(cachePath).pipe(
    Effect.flatMap(decodeZdrCache),
    Effect.map(({ fetchedAtMs: at, models }) => ({
      fetchedAtMs: at,
      prices: new Map(Object.entries(models)) satisfies ZdrPrices,
    })),
    Effect.orElseSucceed(() => null),
  );

  const fetchPrices = httpClient
    .get(ZDR_ENDPOINTS_URL, { headers: { accept: "application/json" } })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((document) => {
        const prices = parseZdrEndpoints(document);
        return prices.size > 0 ? prices : null;
      }),
      Effect.timeout(10_000),
      Effect.orElseSucceed(() => null),
    );

  // A local file, so read when the service is built: the rates are there before anyone asks.
  const cached = yield* readCache;
  const usable = cached !== null && cached.prices.size > 0 ? cached : null;
  fetchedAtMs = usable?.fetchedAtMs ?? null;
  const held = yield* SubscriptionRef.make<RateTable>(
    usable === null ? new Map() : buildMarketRates(usable.prices),
  );

  const load = Effect.fn("OpenRouterZdrRates.load")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (isFresh(now)) return;
    if (lastFailedAtMs !== null && now - lastFailedAtMs < ZDR_RETRY_FLOOR_MS) return;
    const prices = yield* fetchPrices;
    if (prices === null) {
      lastFailedAtMs = now;
      return;
    }
    fetchedAtMs = now;
    lastFailedAtMs = null;
    yield* SubscriptionRef.set(held, buildMarketRates(prices));
    yield* encodeZdrCache({
      version: 1,
      fetchedAtMs: now,
      models: Object.fromEntries(prices),
    }).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.ignoreCause,
    );
  });

  const refresh = lock.withPermit(load());

  // How long until the list is next due: a day after it was fetched, or a backoff after a failure.
  const dueInMs = (now: number) => {
    const dueAtMs =
      lastFailedAtMs !== null
        ? lastFailedAtMs + ZDR_RETRY_FLOOR_MS
        : fetchedAtMs !== null
          ? fetchedAtMs + ZDR_TTL_MS
          : now + ZDR_RETRY_FLOOR_MS;
    return Math.min(Math.max(dueAtMs - now, 1_000), ZDR_TTL_MS);
  };

  // Once something has asked for the rates they keep themselves: they load when missing and again
  // when a day old, and a failure is tried again after its backoff, whoever else asks or not.
  const scope = yield* Effect.scope;
  const upkeep = Effect.forever(
    refresh.pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((now) => Effect.sleep(dueInMs(now))),
    ),
  );
  let keepingUp = false;
  const current = Effect.gen(function* () {
    if (!keepingUp) {
      keepingUp = true;
      yield* Effect.forkIn(upkeep, scope);
    }
    return yield* SubscriptionRef.get(held);
  });
  return OpenRouterZdrRates.of({ current, refresh, changes: SubscriptionRef.changes(held) });
});

export const layer = Layer.effect(OpenRouterZdrRates, make);
