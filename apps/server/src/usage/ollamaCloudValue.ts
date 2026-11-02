import {
  OllamaCloudValuation,
  ollamaCloudRateModel,
  type OllamaCloudValueInput,
} from "@t3tools/provider-opencode/server/ollamaCloudMarket";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OpenRouterZdrRates } from "./OpenRouterZdrRates.ts";
import { priceUsage, type RateTable } from "./usagePricing.ts";

/**
 * What `usedUsd` of Ollama credit would cost at the market rates: the ratio of market to Ollama
 * price over the models that have a market price, applied to the credit the period used. That
 * also values the models without one, and keeps the figure in step with the credit shown.
 */
export function openRouterValueUsd(
  table: RateTable,
  input: OllamaCloudValueInput,
): number | undefined {
  let marketUsd = 0;
  let billedUsd = 0;
  for (const usage of input.models) {
    const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    const totals = {
      uncachedInputTokens,
      cachedInputTokens: Math.min(usage.cachedInputTokens, usage.inputTokens),
      cacheCreationTokens: 0,
      outputTokens: usage.outputTokens,
      reasoningTokens: 0,
    };
    if (usage.usageUsd <= 0 || totalTokens(totals) === 0) continue;
    const priced = priceUsage(table, {
      model: usage.model,
      rateModel: ollamaCloudRateModel(usage.model),
      totals,
      speed: "standard",
      reportedCostUsd: null,
    });
    if (priced.costSource !== "modelPriced") continue;
    marketUsd += priced.costUsd;
    billedUsd += usage.usageUsd;
  }
  return billedUsd > 0 ? (marketUsd / billedUsd) * input.usedUsd : undefined;
}

export const layer = Layer.effect(
  OllamaCloudValuation,
  Effect.gen(function* () {
    const market = yield* OpenRouterZdrRates;
    return OllamaCloudValuation.of({
      openRouterValueUsd: Effect.fn("OllamaCloudValuation.openRouterValueUsd")(function* (input) {
        return openRouterValueUsd(yield* market.current, input);
      }),
    });
  }),
);
