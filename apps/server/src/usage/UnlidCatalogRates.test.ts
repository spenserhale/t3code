// @effect-diagnostics nodeBuiltinImport:off - the fixture writes OpenCode's auth file into a
// private data home with plain node calls, before any Effect service exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as UnlidCatalogRates from "./UnlidCatalogRates.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const DOCUMENT = {
  data: [
    {
      id: "glm-5.3-flash-uncensored",
      name: "GLM",
      available: true,
      context_length: 200000,
      owned_by: "unlid",
      unlid: {
        pricing: { input_usd_per_m: 0.24, output_usd_per_m: 0.96, cache_read_usd_per_m: 0.001 },
      },
    },
    {
      id: "glm-5.3-flash-cached",
      unlid: { pricing: { input_usd_per_m: 0.5, output_usd_per_m: 2, cached_usd_per_m: 0.084 } },
    },
    { id: "no-unlid-section" },
    { id: "half-pricing", unlid: { pricing: { input_usd_per_m: 0.1 } } },
  ],
};

const CATALOG = {
  "glm-5.3-flash-uncensored": {
    inputUsdPerM: 0.24,
    outputUsdPerM: 0.96,
    cachedInputUsdPerM: undefined,
  },
  "glm-5.3-flash-cached": { inputUsdPerM: 0.5, outputUsdPerM: 2, cachedInputUsdPerM: 0.084 },
};

/** Serves the catalog while `online`, once `gate` opens, and records every request. */
function unlid(input: { readonly apiKey?: string; readonly authJson?: string } = {}) {
  const dataHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "unlid-catalog-auth-"));
  if (input.authJson !== undefined) {
    NodeFS.mkdirSync(NodePath.join(dataHome, "opencode"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dataHome, "opencode", "auth.json"), input.authJson);
  }
  const state = {
    online: true,
    document: DOCUMENT as unknown,
    gate: undefined as Deferred.Deferred<void> | undefined,
    requests: [] as HttpClientRequest.HttpClientRequest[],
  };
  const layer = Layer.mergeAll(
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Environment, {
      HOME: dataHome,
      XDG_DATA_HOME: dataHome,
      ...(input.apiKey === undefined ? {} : { UNLID_API_KEY: input.apiKey }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          state.requests.push(request);
          if (state.gate) yield* Deferred.await(state.gate);
          return HttpClientResponse.fromWeb(
            request,
            state.online ? Response.json(state.document) : new Response(null, { status: 503 }),
          );
        }),
      ),
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "unlid-catalog-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { state, layer };
}

/** The first catalog the service holds that has any, waiting for it if need be. */
const firstLoaded = (rates: UnlidCatalogRates.UnlidCatalogRates["Service"]) =>
  rates.changes.pipe(
    Stream.filter((catalog) => Object.keys(catalog).length > 0),
    Stream.runHead,
    Effect.map((catalog) => (catalog._tag === "Some" ? catalog.value : undefined)),
  );

describe("UnlidCatalogRates", () => {
  it.effect("decodes the catalog tolerantly into per-million USD prices", () => {
    const { state, layer } = unlid({ apiKey: "test-key" });
    return Effect.gen(function* () {
      const { current, refresh } = yield* UnlidCatalogRates.make;
      yield* refresh;
      assert.deepStrictEqual(yield* current, CATALOG);
      assert.strictEqual(state.requests[0]?.url, "https://api.unlid.ai/v1/models");
      assert.strictEqual(state.requests[0]?.headers.authorization, "Bearer test-key");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches nothing without a key, and holds an empty catalog", () => {
    const { state, layer } = unlid({
      authJson: JSON.stringify({ "ollama-cloud": { type: "api", key: "other-provider" } }),
    });
    return Effect.gen(function* () {
      const { current, refresh } = yield* UnlidCatalogRates.make;
      yield* refresh;
      yield* refresh;
      assert.deepStrictEqual(yield* current, {});
      assert.strictEqual(state.requests.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prefers the key OpenCode stored over the environment", () => {
    const { state, layer } = unlid({
      apiKey: "env-key",
      authJson: JSON.stringify({
        "ollama-cloud": { type: "api", key: "other-provider" },
        unlid: { type: "api", key: "stored-key" },
      }),
    });
    return Effect.gen(function* () {
      const rates = yield* UnlidCatalogRates.make;
      yield* rates.refresh;
      assert.strictEqual(state.requests[0]?.headers.authorization, "Bearer stored-key");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refetches the catalog only once its six hours are up", () => {
    const { state, layer } = unlid({ apiKey: "test-key" });
    return Effect.gen(function* () {
      const rates = yield* UnlidCatalogRates.make;
      yield* rates.refresh;
      assert.strictEqual(state.requests.length, 1);

      yield* TestClock.adjust("5 hours");
      yield* rates.refresh;
      assert.strictEqual(state.requests.length, 1);
      yield* TestClock.adjust("1 hour");
      yield* rates.refresh;
      assert.strictEqual(state.requests.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the catalog beside itself, so a restart does not fetch again", () => {
    const { state, layer } = unlid({ apiKey: "test-key" });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      yield* (yield* UnlidCatalogRates.make).refresh;
      const cached = decodeJson(
        yield* fileSystem.readFileString(path.join(config.stateDir, "unlid-model-catalog.json")),
      );
      assert.deepStrictEqual(cached, {
        version: 1,
        fetchedAtMs: 0,
        models: {
          "glm-5.3-flash-uncensored": {
            inputUsdPerM: 0.24,
            outputUsdPerM: 0.96,
            cachedInputUsdPerM: null,
          },
          "glm-5.3-flash-cached": {
            inputUsdPerM: 0.5,
            outputUsdPerM: 2,
            cachedInputUsdPerM: 0.084,
          },
        },
      });

      const restarted = yield* (yield* UnlidCatalogRates.make).current;
      assert.deepStrictEqual(restarted, CATALOG);
      assert.strictEqual(state.requests.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("has no catalog, and no error, while the API is out of reach", () => {
    const { state, layer } = unlid({ apiKey: "test-key" });
    state.online = false;
    return Effect.gen(function* () {
      const { current, refresh } = yield* UnlidCatalogRates.make;
      yield* refresh;
      yield* refresh;
      assert.deepStrictEqual(yield* current, {});
      assert.strictEqual(state.requests.length, 1);

      // A well-answered but unpriceable catalog is the same failure: held empty, retried after the floor.
      state.online = true;
      state.document = { data: [{ id: "unpriced" }] };
      yield* TestClock.adjust("10 minutes");
      yield* refresh;
      assert.strictEqual(state.requests.length, 2);
      yield* refresh;
      assert.strictEqual(state.requests.length, 2);
      assert.deepStrictEqual(yield* current, {});
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "answers with what it holds at once, and loads a missing catalog behind the caller",
    () => {
      const { state, layer } = unlid({ apiKey: "test-key" });
      return Effect.gen(function* () {
        state.gate = yield* Deferred.make<void>();
        const rates = yield* UnlidCatalogRates.make;

        // The fetch is held open, yet the answer comes: empty, with the load under way.
        assert.deepStrictEqual(yield* rates.current, {});
        yield* Deferred.succeed(state.gate, undefined);
        assert.deepStrictEqual(yield* firstLoaded(rates), CATALOG);
        // The background load goes on to write the cache; this waits for it to finish.
        yield* rates.refresh;

        assert.deepStrictEqual(yield* rates.current, CATALOG);
        assert.strictEqual(state.requests.length, 1);
      }).pipe(Effect.provide(layer));
    },
  );
});
