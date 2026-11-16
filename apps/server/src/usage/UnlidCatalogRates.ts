import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";

const CATALOG_URL = "https://api.unlid.ai/v1/models";

const CACHE_FILE_NAME = "unlid-model-catalog.json";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_RETRY_FLOOR_MS = 10 * 60 * 1000;

export interface UnlidModelPrice {
  readonly inputUsdPerM: number;
  readonly outputUsdPerM: number;
  readonly cachedInputUsdPerM: number | undefined;
}

// The cache keeps the catalog as served; a missing cached-input price is null on disk.
const CacheEntry = Schema.Struct({
  inputUsdPerM: Schema.Number,
  outputUsdPerM: Schema.Number,
  cachedInputUsdPerM: Schema.NullOr(Schema.Number),
});
const CacheFile = Schema.Struct({
  version: Schema.Literal(1),
  fetchedAtMs: Schema.Number,
  models: Schema.Record(Schema.String, CacheEntry),
});
const decodeCache = Schema.decodeUnknownEffect(Schema.fromJsonString(CacheFile));
const encodeCache = Schema.encodeEffect(Schema.fromJsonString(CacheFile));

// OpenCode stores provider credentials in its auth.json; each reader owns its own slice.
const AuthFile = Schema.Struct({ unlid: Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
const emptyAuthFile: Schema.Schema.Type<typeof AuthFile> = {};

// The envelope is the only shape worth a schema; items decode one by one so a bad one is skipped.
const CatalogResponse = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const decodeCatalogResponse = Schema.decodeUnknownOption(CatalogResponse);
const PricedItem = Schema.Struct({
  id: Schema.String,
  unlid: Schema.Struct({
    pricing: Schema.Struct({
      input_usd_per_m: Schema.Number,
      output_usd_per_m: Schema.Number,
    }),
  }),
});
const RawPricing = Schema.Struct({
  unlid: Schema.Struct({ pricing: Schema.Record(Schema.String, Schema.Unknown) }),
});
const decodePricedItem = Schema.decodeUnknownOption(PricedItem);
const decodeRawPricing = Schema.decodeUnknownOption(RawPricing);

const toCatalog = (
  models: Record<string, Schema.Schema.Type<typeof CacheEntry>>,
): Record<string, UnlidModelPrice> =>
  Object.fromEntries(
    Object.entries(models).map(([id, price]) => [
      id,
      { ...price, cachedInputUsdPerM: price.cachedInputUsdPerM ?? undefined },
    ]),
  );

const toCacheModels = (
  catalog: Record<string, UnlidModelPrice>,
): Record<string, Schema.Schema.Type<typeof CacheEntry>> =>
  Object.fromEntries(
    Object.entries(catalog).map(([id, price]) => [
      id,
      { ...price, cachedInputUsdPerM: price.cachedInputUsdPerM ?? null },
    ]),
  );

/** The first numeric field named `cached*` in an item's pricing (expected `cached_usd_per_m`). */
const cachedInputUsdPerM = (item: unknown): number | undefined =>
  Option.map(decodeRawPricing(item), ({ unlid }) => {
    for (const [name, value] of Object.entries(unlid.pricing)) {
      if (name.startsWith("cached") && typeof value === "number") return value;
    }
    return undefined;
  }).pipe(Option.getOrUndefined);

/** Items without an id or both published prices are skipped; nothing priced at all is no catalog. */
const parseCatalog = (document: unknown): Record<string, UnlidModelPrice> | null => {
  const response = Option.getOrUndefined(decodeCatalogResponse(document));
  if (response === undefined) return null;
  const catalog: Record<string, UnlidModelPrice> = {};
  for (const item of response.data) {
    const priced = Option.getOrUndefined(decodePricedItem(item));
    if (priced === undefined) continue;
    catalog[priced.id] = {
      inputUsdPerM: priced.unlid.pricing.input_usd_per_m,
      outputUsdPerM: priced.unlid.pricing.output_usd_per_m,
      cachedInputUsdPerM: cachedInputUsdPerM(item),
    };
  }
  return Object.keys(catalog).length > 0 ? catalog : null;
};

export class UnlidCatalogRates extends Context.Service<
  UnlidCatalogRates,
  {
    /** The catalog held now. Never waits; the first call starts keeping it fresh in the background. */
    readonly current: Effect.Effect<Record<string, UnlidModelPrice>>;
    /** Fetches the catalog now if it is missing or six hours old, and waits for the attempt. */
    readonly refresh: Effect.Effect<void>;
    /** The catalog held now, then each new set as the service comes to hold it. */
    readonly changes: Stream.Stream<Record<string, UnlidModelPrice>>;
  }
>()("t3/usage/UnlidCatalogRates") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const cachePath = path.join(config.stateDir, CACHE_FILE_NAME);

  let fetchedAtMs: number | null = null;
  let lastFailedAtMs: number | null = null;
  const lock = yield* Semaphore.make(1);

  const isFresh = (now: number) =>
    fetchedAtMs !== null && now - fetchedAtMs >= 0 && now - fetchedAtMs < CATALOG_TTL_MS;

  /** The key OpenCode stored for Unlid, else `UNLID_API_KEY`. Never logged, never in an error. */
  const readApiKey = Effect.fn("UnlidCatalogRates.readApiKey")(function* () {
    const env = yield* HostProcess.Environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    const contents = yield* fileSystem
      .readFileString(path.join(dataHome, "opencode", "auth.json"))
      .pipe(Effect.orElseSucceed(() => "{}"));
    const file = yield* decodeAuthFile(contents).pipe(Effect.orElseSucceed(() => emptyAuthFile));
    const apiAuth = decodeApiAuth(file.unlid);
    return (Option.isSome(apiAuth) ? apiAuth.value.key : env.UNLID_API_KEY)?.trim();
  });

  const fetchCatalog = (apiKey: string) =>
    httpClient
      .get(CATALOG_URL, {
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.map(parseCatalog),
        Effect.timeout(10_000),
        Effect.orElseSucceed(() => null),
      );

  const readCache = fileSystem.readFileString(cachePath).pipe(
    Effect.flatMap(decodeCache),
    Effect.map(({ fetchedAtMs: at, models }) => ({ fetchedAtMs: at, catalog: toCatalog(models) })),
    Effect.orElseSucceed(() => null),
  );

  // A local file, so read when the service is built: the catalog is there before anyone asks.
  // Without a key there is no catalog to serve and nothing to fetch.
  const apiKey = yield* readApiKey();
  const hasKey = apiKey !== undefined && apiKey !== "";
  const cached = hasKey ? yield* readCache : null;
  const usable = cached !== null && Object.keys(cached.catalog).length > 0 ? cached : null;
  fetchedAtMs = usable?.fetchedAtMs ?? null;
  const held = yield* SubscriptionRef.make<Record<string, UnlidModelPrice>>(
    usable === null ? {} : usable.catalog,
  );

  const load = Effect.fn("UnlidCatalogRates.load")(function* () {
    const key = yield* readApiKey();
    if (key === undefined || key === "") return;
    const now = yield* Clock.currentTimeMillis;
    if (isFresh(now)) return;
    if (lastFailedAtMs !== null && now - lastFailedAtMs < CATALOG_RETRY_FLOOR_MS) return;
    const catalog = yield* fetchCatalog(key);
    if (catalog === null) {
      lastFailedAtMs = now;
      return;
    }
    fetchedAtMs = now;
    lastFailedAtMs = null;
    yield* SubscriptionRef.set(held, catalog);
    yield* encodeCache({ version: 1, fetchedAtMs: now, models: toCacheModels(catalog) }).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.ignoreCause,
    );
  });

  const refresh = lock.withPermit(load());

  // How long until the catalog is next due: six hours after it was fetched, or a backoff after a failure.
  const dueInMs = (now: number) => {
    const dueAtMs =
      lastFailedAtMs !== null
        ? lastFailedAtMs + CATALOG_RETRY_FLOOR_MS
        : fetchedAtMs !== null
          ? fetchedAtMs + CATALOG_TTL_MS
          : now + CATALOG_RETRY_FLOOR_MS;
    return Math.min(Math.max(dueAtMs - now, 1_000), CATALOG_TTL_MS);
  };

  // Once something has asked for the catalog it keeps itself: it loads when missing and again when
  // six hours old, and a failure is tried again after its backoff, whoever else asks or not.
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
  return UnlidCatalogRates.of({ current, refresh, changes: SubscriptionRef.changes(held) });
});

/** @public */
export const layer = Layer.effect(UnlidCatalogRates, make);
