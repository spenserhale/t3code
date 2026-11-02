import {
  OllamaCloudValuation,
  type OllamaCloudModelUsage,
} from "@t3tools/provider-opencode/server/ollamaCloudMarket";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

describe("openRouterValueUsd", () => {
  // 3000 uncached x 1.0 + 1000 cached x 0.1 + 1000 output x 3.0 = 6100 -> $0.0061 at the market.
  const glm = usage("glm-5.3", 0.0122, 4000, 1000, 1000);

  it("applies the market-to-Ollama ratio of the priced models to the credit used", () => {
    // Ollama billed twice the market price, so $10 of credit is worth $5.
    assert.closeTo(openRouterValueUsd(market, { usedUsd: 10, models: [glm] })!, 5, 1e-9);
  });

  it("values what it cannot price, and what Ollama lumps together, at that same ratio", () => {
    const unpriced = usage("unheard-of", 100, 5_000_000, 0, 1_000_000);
    const other = openRouterValueUsd(market, { usedUsd: 10, models: [glm, unpriced] });
    assert.closeTo(other!, 5, 1e-9);
  });

  it("weighs each priced model by what it cost", () => {
    // gpt-oss: 10000 x 0.1 + 2000 x 0.4 = 1800 -> $0.0018 at the market for $0.0036 billed.
    const gptOss = usage("gpt-oss:120b", 0.0036, 10_000, 0, 2000);
    const ratio = (0.0061 + 0.0018) / (0.0122 + 0.0036);
    assert.closeTo(
      openRouterValueUsd(market, { usedUsd: 8, models: [glm, gptOss] })!,
      ratio * 8,
      1e-9,
    );
  });

  it("clamps cached tokens to the input they are part of", () => {
    const odd = usage("glm-5.3", 0.002, 1000, 4000, 0);
    // 1000 cached tokens at 0.1 = $0.0001 for $0.002 billed.
    assert.closeTo(openRouterValueUsd(market, { usedUsd: 1, models: [odd] })!, 0.05, 1e-9);
  });

  it("has no value when no model has a market price or any usage to weigh", () => {
    for (const models of [
      [],
      [usage("unheard-of", 1, 1000, 0, 1000)],
      [usage("glm-5.3", 0, 1000, 0, 1000)],
      [usage("glm-5.3", 1, 0, 0, 0)],
    ]) {
      assert.isUndefined(openRouterValueUsd(market, { usedUsd: 10, models }));
    }
  });
});

describe("OllamaCloudValuation layer", () => {
  it.effect("prices with the rates the service holds when it is asked", () =>
    Effect.gen(function* () {
      const valuation = yield* OllamaCloudValuation;
      const value = yield* valuation.openRouterValueUsd({
        usedUsd: 10,
        models: [usage("glm-5.3", 0.0122, 4000, 1000, 1000)],
      });
      assert.closeTo(value!, 5, 1e-9);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.succeed(OpenRouterZdrRates, {
              rates: Effect.succeed(new Map()),
              current: Effect.succeed(market),
            }),
          ),
        ),
      ),
    ),
  );
});
