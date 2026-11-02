import {
  OllamaCloudValuation,
  type OllamaCloudModelUsage,
  type OllamaCloudValueInput,
} from "@t3tools/provider-opencode/server/ollamaCloudMarket";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layer, openRouterValueUsd } from "./ollamaCloudValue.ts";
import { OpenRouterZdrRates } from "./OpenRouterZdrRates.ts";
import { buildMarketRates } from "./openRouterZdr.ts";

// glm-5.3 costs 1.0 / 0.1 / 3.0 USD per million input / cached / output tokens at the market.
const market = buildMarketRates(
  new Map([
    ["z-ai/glm-5.3", { promptUsd: 1e-6, completionUsd: 3e-6, cacheReadUsd: 1e-7 }],
    ["openai/gpt-oss-120b", { promptUsd: 1e-7, completionUsd: 4e-7, cacheReadUsd: null }],
  ]),
);

const usage = (
  model: string,
  usageUsd: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): OllamaCloudModelUsage => ({ model, usageUsd, inputTokens, cachedInputTokens, outputTokens });

/** By default the history accounts for all the credit used. */
const input = (
  models: ReadonlyArray<OllamaCloudModelUsage>,
  rest: Partial<Pick<OllamaCloudValueInput, "usedUsd" | "remainderUsageUsd">> = {},
): OllamaCloudValueInput => ({
  usedUsd: models.reduce((sum, entry) => sum + entry.usageUsd, 0) + (rest.remainderUsageUsd ?? 0),
  remainderUsageUsd: 0,
  models,
  ...rest,
});

describe("openRouterValueUsd", () => {
  // 3000 uncached x 1.0 + 1000 cached x 0.1 + 1000 output x 3.0 = 6100 -> $0.0061 at the market.
  const glm = usage("glm-5.3", 0.0122, 4000, 1000, 1000);
  // No market price, and as many Ollama dollars as glm-5.3: exactly half of the total.
  const unpriced = usage("unheard-of", 0.0122, 5_000_000, 0, 1_000_000);

  it("applies the market-to-Ollama ratio of the priced models to the credit used", () => {
    // Ollama billed twice the market price, so $0.0122 of credit is worth $0.0061.
    assert.closeTo(openRouterValueUsd(market, input([glm]))!, 0.0061, 1e-9);
    assert.closeTo(openRouterValueUsd(market, input([glm], { usedUsd: 0.0122 }))!, 0.0061, 1e-9);
  });

  it("values what it cannot price at that same ratio, while half of the dollars are priced", () => {
    assert.closeTo(openRouterValueUsd(market, input([glm, unpriced]))!, 0.0122, 1e-9);
    assert.closeTo(
      openRouterValueUsd(market, input([glm], { remainderUsageUsd: 0.0122 }))!,
      0.0122,
      1e-9,
    );
  });

  it("counts credit spent beyond the history against the share, so it cannot drop out", () => {
    // The history keeps to whole days, so the first day after a renewal is not in it. Here that day
    // holds all but $0.0122 of the credit used: 1 in 51, however well the rest is priced.
    assert.isUndefined(openRouterValueUsd(market, input([glm], { usedUsd: 0.0122 * 51 })));
    // Half of the credit used was priced directly: shown. A little less is not.
    assert.closeTo(openRouterValueUsd(market, input([glm], { usedUsd: 0.0244 }))!, 0.0122, 1e-9);
    assert.isUndefined(openRouterValueUsd(market, input([glm], { usedUsd: 0.0245 })));
    // Bought credit can make the history larger than the included credit used; it counts whole.
    assert.closeTo(
      openRouterValueUsd(market, input([glm, unpriced], { usedUsd: 0.001 }))!,
      0.0005,
      1e-9,
    );
  });

  it("has no value when less than half of the period's dollars were priced directly", () => {
    const slightlyMore = { ...unpriced, usageUsd: 0.0123 };
    assert.isUndefined(openRouterValueUsd(market, input([glm, slightlyMore])));
    // Ollama's remainder group, the models beyond its ten, counts against the share too.
    assert.isUndefined(openRouterValueUsd(market, input([glm], { remainderUsageUsd: 0.0123 })));
    // A model with dollars but no tokens to price is unpriced, however it is spelled.
    assert.isUndefined(openRouterValueUsd(market, input([glm, usage("glm-5.3", 0.0123, 0, 0, 0)])));
  });

  it("weighs each priced model by what it cost", () => {
    // gpt-oss: 10000 x 0.1 + 2000 x 0.4 = 1800 -> $0.0018 at the market for $0.0036 billed.
    const gptOss = usage("gpt-oss:120b", 0.0036, 10_000, 0, 2000);
    const ratio = (0.0061 + 0.0018) / (0.0122 + 0.0036);
    assert.closeTo(
      openRouterValueUsd(market, input([glm, gptOss], { usedUsd: 0.0158 }))!,
      ratio * 0.0158,
      1e-9,
    );
  });

  it("clamps cached tokens to the input they are part of", () => {
    const odd = usage("glm-5.3", 0.002, 1000, 4000, 0);
    // 1000 cached tokens at 0.1 = $0.0001 for $0.002 billed.
    assert.closeTo(openRouterValueUsd(market, input([odd]))!, 0.0001, 1e-9);
  });

  it("has no value when no model has a market price or any usage to weigh", () => {
    for (const models of [
      [],
      [usage("unheard-of", 1, 1000, 0, 1000)],
      [usage("glm-5.3", 0, 1000, 0, 1000)],
      [usage("glm-5.3", 1, 0, 0, 0)],
    ]) {
      assert.isUndefined(openRouterValueUsd(market, input(models)));
    }
  });
});

describe("OllamaCloudValuation layer", () => {
  it.effect("prices with the rates the service holds when it is asked", () =>
    Effect.gen(function* () {
      const valuation = yield* OllamaCloudValuation;
      const value = yield* valuation.openRouterValueUsd(
        input([usage("glm-5.3", 0.0122, 4000, 1000, 1000)]),
      );
      assert.closeTo(value!, 0.0061, 1e-9);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.succeed(OpenRouterZdrRates, {
              current: Effect.succeed(market),
              refresh: Effect.void,
              changes: Stream.empty,
            }),
          ),
        ),
      ),
    ),
  );
});
