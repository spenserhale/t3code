// @effect-diagnostics nodeBuiltinImport:off - the service reads provider homes on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexUsageHistory from "./CodexUsageHistory.ts";
import { UnlidCatalogRates, type UnlidModelPrice } from "./UnlidCatalogRates.ts";
import * as UsageService from "./UsageService.ts";
import { lookupRate } from "./usagePricing.ts";

/** A usage service whose rate source answers each fetch with `respond()`. */
const usageLayer = (input: {
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly respond: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly catalog?: Record<string, UnlidModelPrice>;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-rates-test-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const service = UsageService.layer.pipe(
        Layer.provide(
          Layer.fresh(CursorUsageAccounts.layer).pipe(
            Layer.provide(CursorAccountReader.layer),
            Layer.provideMerge(AntigravityUsage.layer),
            Layer.provideMerge(MuseUsageHome.layer),
            Layer.provideMerge(ProviderHostLive.layer),
            Layer.provideMerge(
              CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
            ),
            Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
            Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-rates-" }),
            ),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provideMerge(ServerSettings.layerTest(input.settings)),
            Layer.provideMerge(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.sync(() => HttpClientResponse.fromWeb(request, input.respond(request))),
                ),
              ),
            ),
            Layer.provideMerge(Layer.succeed(HostProcess.Environment, { HOME: home })),
          ),
        ),
      );
      return input.catalog === undefined
        ? service
        : service.pipe(
            Layer.provideMerge(
              Layer.mock(UnlidCatalogRates)({ current: Effect.succeed(input.catalog) }),
            ),
          );
    }),
  );

it.effect("serves the rates a summary prices with, custom prices and mappings included", () => {
  let fetches = 0;
  return Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    const rates = yield* usage.currentRates;

    assert.strictEqual(lookupRate(rates.table, "published-model")?.outputCostPerToken, 2e-6);
    assert.strictEqual(rates.overrides.get("house-model")?.outputCostPerToken, 9e-6);
    assert.deepStrictEqual(
      [...rates.aliases],
      [
        ["old-name", "published-model"],
        ["middle-name", "published-model"],
      ],
    );

    // A fresh table is served as is, however often it is asked for.
    yield* usage.currentRates;
    assert.strictEqual(fetches, 1);
  }).pipe(
    Effect.provide(
      usageLayer({
        settings: {
          usagePriceOverrides: {
            "house-model": { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 9 },
          },
          usageModelAliases: { "old-name": "middle-name", "middle-name": "published-model" },
        },
        respond: () => {
          fetches += 1;
          return Response.json({
            "published-model": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
          });
        },
      }),
    ),
  );
});

it.effect("does not hold every read on a rate source that cannot be reached", () => {
  let fetches = 0;
  return Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;

    const first = yield* usage.currentRates;
    yield* usage.currentRates;
    yield* usage.currentRates;
    assert.strictEqual(first.table.size, 0);
    assert.strictEqual(fetches, 1);

    yield* TestClock.adjust("61 seconds");
    yield* usage.currentRates;
    assert.strictEqual(fetches, 2);
  }).pipe(
    Effect.provide(
      usageLayer({
        settings: {},
        respond: (request) => {
          // A failed read also tries the GitHub API once; that second request is the same read.
          if (!request.url.startsWith("https://api.github.com/")) fetches += 1;
          return new Response("unavailable", { status: 503 });
        },
      }),
    ),
  );
});

it.effect("fills unpriced ids from the catalog and never reprices others", () => {
  return Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    const rates = yield* usage.currentRates;

    // The custom price and the published table keep their prices; only ids with no price fill.
    assert.strictEqual(rates.overrides.get("m")?.inputCostPerToken, 1e-6);
    assert.isUndefined(rates.table.get("m"));
    assert.strictEqual(lookupRate(rates.table, "y")?.inputCostPerToken, 9e-7);
    assert.strictEqual(rates.table.get("x")?.inputCostPerToken, 0.24e-6);
    assert.strictEqual(rates.table.get("x")?.outputCostPerToken, 0.96e-6);
    assert.strictEqual(rates.table.get("x")?.fast, null);
    // A catalog cache price maps to the cached-input rate; cache writes price at input.
    assert.strictEqual(rates.table.get("w")?.cacheReadCostPerToken, 0.5e-6);
    assert.strictEqual(rates.table.get("w")?.cacheCreationCostPerToken, 1e-6);
  }).pipe(
    Effect.provide(
      usageLayer({
        settings: {
          usagePriceOverrides: {
            m: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 1 },
          },
        },
        respond: () =>
          Response.json({ y: { input_cost_per_token: 9e-7, output_cost_per_token: 2e-6 } }),
        catalog: {
          m: { inputUsdPerM: 0.5, outputUsdPerM: 1.5, cachedInputUsdPerM: undefined },
          y: { inputUsdPerM: 0.1, outputUsdPerM: 0.2, cachedInputUsdPerM: undefined },
          x: { inputUsdPerM: 0.24, outputUsdPerM: 0.96, cachedInputUsdPerM: undefined },
          w: { inputUsdPerM: 1, outputUsdPerM: 2, cachedInputUsdPerM: 0.5 },
        },
      }),
    ),
  );
});

it.effect("leaves the published table alone with no catalog service in the context", () => {
  return Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    const rates = yield* usage.currentRates;

    assert.deepStrictEqual(
      [...rates.table],
      [
        [
          "y",
          {
            inputCostPerToken: 9e-7,
            outputCostPerToken: 2e-6,
            cacheReadCostPerToken: 9e-7,
            cacheCreationCostPerToken: 9e-7,
            fast: null,
            ultrafast: null,
          },
        ],
      ],
    );
  }).pipe(
    Effect.provide(
      usageLayer({
        settings: {},
        respond: () =>
          Response.json({ y: { input_cost_per_token: 9e-7, output_cost_per_token: 2e-6 } }),
      }),
    ),
  );
});
