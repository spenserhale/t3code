import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ollamaCloudRateModel } from "@t3tools/provider-opencode/server/ollamaCloudMarket";
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
import * as OpenRouterZdrRates from "./OpenRouterZdrRates.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const endpoint = (prompt: string, completion: string) => ({
  model_id: "openai/gpt-oss-120b",
  status: 0,
  service_tier: null,
  safety_retention: false,
  pricing: { prompt, completion, input_cache_read: "0.00000001", discount: 0 },
});

const DOCUMENT = {
  data: [endpoint("0.0000001", "0.0000004"), endpoint("0.0000003", "0.0000006")],
};
const KEY = ollamaCloudRateModel("gpt-oss:120b");

/** Serves the list while `online`, once `gate` opens, and records every request. */
function openRouter() {
  const state = {
    online: true,
    gate: undefined as Deferred.Deferred<void> | undefined,
    requests: [] as HttpClientRequest.HttpClientRequest[],
  };
  const layer = Layer.mergeAll(
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          state.requests.push(request);
          if (state.gate) yield* Deferred.await(state.gate);
          return HttpClientResponse.fromWeb(
            request,
            state.online ? Response.json(DOCUMENT) : new Response(null, { status: 503 }),
          );
        }),
      ),
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "openrouter-zdr-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { state, layer };
}

/** The first set of rates the service holds that has any, waiting for it if need be. */
const firstLoaded = (rates: OpenRouterZdrRates.OpenRouterZdrRates["Service"]) =>
  rates.changes.pipe(
    Stream.filter((table) => table.size > 0),
    Stream.runHead,
    Effect.map((table) => (table._tag === "Some" ? table.value : undefined)),
  );

describe("OpenRouterZdrRates", () => {
  it.effect(
    "fetches the list once a day, and prices Ollama Cloud's models from its medians",
    () => {
      const { state, layer } = openRouter();
      return Effect.gen(function* () {
        const { current, refresh } = yield* OpenRouterZdrRates.make;
        yield* refresh;
        const table = yield* current;
        assert.closeTo(table.get(KEY)?.inputCostPerToken ?? 0, 2e-7, 1e-15);
        assert.closeTo(table.get(KEY)?.outputCostPerToken ?? 0, 5e-7, 1e-15);
        assert.strictEqual(state.requests[0]?.url, "https://openrouter.ai/api/v1/endpoints/zdr");

        yield* refresh;
        yield* TestClock.adjust("23 hours");
        yield* refresh;
        assert.strictEqual(state.requests.length, 1);
        yield* TestClock.adjust("1 hour");
        yield* refresh;
        assert.strictEqual(state.requests.length, 2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps the medians beside the LiteLLM rates, so a restart does not fetch again", () => {
    const { state, layer } = openRouter();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      yield* (yield* OpenRouterZdrRates.make).refresh;
      const cached = decodeJson(
        yield* fileSystem.readFileString(path.join(config.stateDir, "openrouter-zdr-rates.json")),
      );
      assert.deepStrictEqual(cached, {
        version: 1,
        fetchedAtMs: 0,
        models: {
          "openai/gpt-oss-120b": {
            promptUsd: 2e-7,
            completionUsd: 5e-7,
            cacheReadUsd: 1e-8,
          },
        },
      });

      const restarted = yield* (yield* OpenRouterZdrRates.make).current;
      assert.isTrue(restarted.has(KEY));
      assert.strictEqual(state.requests.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps the rates it has when a daily fetch fails, and waits before trying again",
    () => {
      const { state, layer } = openRouter();
      return Effect.gen(function* () {
        const rates = yield* OpenRouterZdrRates.make;
        yield* rates.refresh;
        state.online = false;

        yield* TestClock.adjust("25 hours");
        yield* rates.refresh;
        assert.strictEqual(state.requests.length, 2);
        yield* TestClock.adjust("9 minutes");
        yield* rates.refresh;
        assert.strictEqual(state.requests.length, 2);

        state.online = true;
        yield* TestClock.adjust("1 minute");
        yield* rates.refresh;
        assert.strictEqual(state.requests.length, 3);
        yield* TestClock.adjust("23 hours");
        yield* rates.refresh;
        assert.strictEqual(state.requests.length, 3);
        assert.isTrue((yield* firstLoaded(rates))?.has(KEY));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("holds the rates it has through a failed fetch", () => {
    const { state, layer } = openRouter();
    return Effect.gen(function* () {
      const rates = yield* OpenRouterZdrRates.make;
      yield* rates.refresh;
      state.online = false;
      yield* TestClock.adjust("25 hours");
      yield* rates.refresh;
      assert.strictEqual(state.requests.length, 2);
      assert.isTrue((yield* firstLoaded(rates))?.has(KEY));
    }).pipe(Effect.provide(layer));
  });

  it.effect("has no rates, and no error, while the list is out of reach", () => {
    const { state, layer } = openRouter();
    state.online = false;
    return Effect.gen(function* () {
      const { current, refresh } = yield* OpenRouterZdrRates.make;
      yield* refresh;
      yield* refresh;
      assert.strictEqual((yield* current).size, 0);
      assert.strictEqual(state.requests.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "answers with what it holds at once, and loads a missing list behind the caller",
    () => {
      const { state, layer } = openRouter();
      return Effect.gen(function* () {
        state.gate = yield* Deferred.make<void>();
        const rates = yield* OpenRouterZdrRates.make;

        // The fetch is held open, yet the answer comes: empty, with the load under way.
        assert.strictEqual((yield* rates.current).size, 0);
        yield* Deferred.succeed(state.gate, undefined);
        assert.isTrue((yield* firstLoaded(rates))?.has(KEY));
        // The background load goes on to write the cache; this waits for it to finish.
        yield* rates.refresh;

        assert.isTrue((yield* rates.current).has(KEY));
        assert.strictEqual(state.requests.length, 1);
      }).pipe(Effect.provide(layer));
    },
  );
});
