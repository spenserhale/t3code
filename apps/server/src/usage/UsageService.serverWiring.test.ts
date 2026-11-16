// @effect-diagnostics nodeBuiltinImport:off - the fixture seeds the catalog cache with plain
// node calls, before any Effect service exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
// The server's own usage composition; this is the stack a live server builds for usage.
import { layerUsage } from "../server.ts";
import * as UsageService from "./UsageService.ts";
import { lookupRate } from "./usagePricing.ts";

// The same derivation config.ts makes from a base dir, so the cache is in place before the
// composition builds and the catalog service holds it without a fetch.
const seedCatalogCache = (home: string) => {
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata", "unlid-model-catalog.json"),
    JSON.stringify({
      version: 1,
      fetchedAtMs: 0,
      models: {
        "unlid-wired-model": {
          inputUsdPerM: 0.24,
          outputUsdPerM: 0.96,
          cachedInputUsdPerM: 0.084,
        },
      },
    }),
  );
};

it.effect("the server composition hands UnlidCatalogRates to the usage service", () => {
  return Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    const rates = yield* usage.currentRates;

    // Every rate source is unreachable here, so the catalog is the only price there is.
    assert.strictEqual(rates.table.size, 1);
    const rate = lookupRate(rates.table, "unlid-wired-model");
    assert.strictEqual(rate?.inputCostPerToken, 0.24 / 1_000_000);
    assert.strictEqual(rate?.cacheReadCostPerToken, 0.084 / 1_000_000);
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const home = yield* Effect.acquireRelease(
            Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "usage-wiring-"))),
            (home) => Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true })),
          );
          seedCatalogCache(home);
          return layerUsage.pipe(
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            Layer.provideMerge(Sqlite.layerMemory),
            Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
            Layer.provideMerge(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.sync(() =>
                    HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
                  ),
                ),
              ),
            ),
            Layer.provideMerge(
              Layer.succeed(HostProcess.Environment, {
                HOME: home,
                XDG_DATA_HOME: home,
                UNLID_API_KEY: "wiring-key",
              }),
            ),
          );
        }),
      ),
    ),
  );
});
