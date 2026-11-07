import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { ollamaCloudRateModel } from "@t3tools/provider-opencode/server/ollamaCloudMarket";
import { assert, describe, it } from "@effect/vitest";

import {
  buildMarketRates,
  parseZdrEndpoints,
  withMarketRates,
  withoutCatalogCost,
  type ZdrModelPrice,
  type ZdrPrices,
} from "./openRouterZdr.ts";
import { lookupRate, parseRateTable, priceUsage } from "./usagePricing.ts";

// Shaped like the entries of https://openrouter.ai/api/v1/endpoints/zdr.
const endpoint = (
  modelId: string,
  prompt: string,
  completion: string,
  rest: {
    readonly cacheRead?: string | null;
    readonly status?: number;
    readonly tier?: string | null;
    readonly safetyRetention?: boolean;
    readonly discount?: number;
  } = {},
) => ({
  name: `Provider | ${modelId}`,
  model_id: modelId,
  provider_name: "Provider",
  status: rest.status ?? 0,
  service_tier: rest.tier ?? null,
  safety_retention: rest.safetyRetention ?? false,
  pricing: {
    prompt,
    completion,
    ...(rest.cacheRead === undefined ? {} : { input_cache_read: rest.cacheRead }),
    discount: rest.discount ?? 0,
  },
});

const priceOf = (prices: ZdrPrices, modelId: string) => {
  const found = prices.get(modelId);
  return found && [found.promptUsd, found.completionUsd, found.cacheReadUsd];
};

describe("parseZdrEndpoints", () => {
  it("takes the median of each price over the endpoints that are up and keep nothing", () => {
    const prices = parseZdrEndpoints({
      data: [
        endpoint("openai/gpt-oss-120b", "0.00000006", "0.0000004", { cacheRead: "0.00000003" }),
        endpoint("openai/gpt-oss-120b", "0.00000003", "0.00000015", { cacheRead: "0.000000015" }),
        endpoint("openai/gpt-oss-120b", "0.00000005", "0.00000025", { cacheRead: null }),
        endpoint("openai/gpt-oss-120b", "0.00000009", "0.0000006"),
        // Each of these is left out of the median.
        endpoint("openai/gpt-oss-120b", "0.000002", "0.000002", { status: -2 }),
        endpoint("openai/gpt-oss-120b", "0.000002", "0.000002", { status: -5 }),
        endpoint("openai/gpt-oss-120b", "0.000002", "0.000002", { tier: "priority" }),
        endpoint("openai/gpt-oss-120b", "0.000002", "0.000002", { tier: "flex" }),
        endpoint("openai/gpt-oss-120b", "0.000002", "0.000002", { safetyRetention: true }),
        endpoint("openai/gpt-oss-120b", "0", "0.000002"),
        endpoint("openai/gpt-oss-120b", "free", "0.000002"),
        { model_id: "openai/gpt-oss-120b", pricing: "malformed" },
      ],
    });

    // Prompt 3, 5, 6, 9 -> 5.5; completion 15, 25, 40, 60 -> 32.5; cache read 1.5 and 3 -> 2.25.
    const [prompt, completion, cacheRead] = priceOf(prices, "openai/gpt-oss-120b")!;
    assert.closeTo(prompt!, 5.5e-8, 1e-15);
    assert.closeTo(completion!, 3.25e-7, 1e-14);
    assert.closeTo(cacheRead!, 2.25e-8, 1e-15);
  });

  it("reports no cache-read price when no usable endpoint lists one", () => {
    const prices = parseZdrEndpoints({ data: [endpoint("a/model", "0.000001", "0.000002")] });
    assert.deepStrictEqual(priceOf(prices, "a/model"), [0.000001, 0.000002, null]);
  });

  it("uses the listed price, which already includes any discount", () => {
    const prices = parseZdrEndpoints({
      data: [endpoint("a/model", "0.000001", "0.000002", { discount: 0.3 })],
    });
    assert.deepStrictEqual(priceOf(prices, "a/model"), [0.000001, 0.000002, null]);
  });

  it("is empty for a document it cannot read", () => {
    for (const document of [null, "nope", {}, { data: "x" }, { data: [] }]) {
      assert.strictEqual(parseZdrEndpoints(document).size, 0);
    }
  });
});

describe("buildMarketRates", () => {
  const price = (promptUsd: number): ZdrModelPrice => ({
    promptUsd,
    completionUsd: promptUsd * 4,
    cacheReadUsd: null,
  });

  it("maps Ollama's tags onto OpenRouter's models, by table and by name", () => {
    const mapped = [
      ["gpt-oss:120b", "openai/gpt-oss-120b"],
      ["glm-5.3", "z-ai/glm-5.3"],
      ["glm-5.3-flash", "z-ai/glm-5.3-flash"],
      ["kimi-k3", "moonshotai/kimi-k3"],
      ["kimi-k2.7-code", "moonshotai/kimi-k2.7-code"],
      ["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash"],
      ["deepseek-v4-pro:0813", "deepseek/deepseek-v4-pro-0813"],
      ["minimax-m3", "minimax/minimax-m3"],
      ["gemma4:31b", "google/gemma-4-31b-it"],
      ["mistral-large-4", "mistralai/mistral-large-4-0"],
      ["nemotron-3-ultra", "nvidia/nemotron-3-ultra-550b-a55b"],
    ] as const;
    const prices: ZdrPrices = new Map([
      ...mapped.map(([, openRouterId], index) => [openRouterId, price(index + 1)] as const),
      ["openai/gpt-oss-20b", price(100)],
      ["unrelated/other-model", price(200)],
    ]);
    const rates = buildMarketRates(prices);

    mapped.forEach(([ollamaId], index) => {
      assert.strictEqual(rates.get(ollamaCloudRateModel(ollamaId))?.inputCostPerToken, index + 1);
    });
    // Not in the table, but named alike.
    assert.strictEqual(rates.get(ollamaCloudRateModel("gpt-oss:20b"))?.inputCostPerToken, 100);
    // Nothing offers Ollama's `qwen3:32b` a price.
    assert.isUndefined(rates.get(ollamaCloudRateModel("qwen3:32b")));
  });

  it("keeps every key in Ollama Cloud's namespace and leaves a shared name unpriced", () => {
    const rates = buildMarketRates(
      new Map([
        ["openai/gpt-oss-120b", price(1)],
        ["first/shared-name", price(2)],
        ["second/shared-name", price(3)],
      ]),
    );
    assert.deepStrictEqual([...rates.keys()].toSorted(), ["ollama-cloud/gpt-oss-120b"]);
  });

  it("prices a missing cache-read rate as plain input, and never prices speed tiers", () => {
    const rates = buildMarketRates(new Map([["openai/gpt-oss-120b", price(2)]]));
    const rate = rates.get(ollamaCloudRateModel("gpt-oss:120b"));
    assert.strictEqual(rate?.cacheReadCostPerToken, 2);
    assert.strictEqual(rate?.cacheCreationCostPerToken, 2);
    assert.isNull(rate?.fast);
    assert.isNull(rate?.ultrafast);
  });
});

describe("withMarketRates", () => {
  const litellm = parseRateTable({
    "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
  });
  const market = buildMarketRates(
    new Map([
      ["openai/gpt-oss-120b", { promptUsd: 1e-7, completionUsd: 4e-7, cacheReadUsd: 1e-8 }],
    ]),
  );

  it("prices Ollama Cloud's model at the market rate under the id its readers have", () => {
    const table = withMarketRates(litellm, market);
    const tokens = {
      uncachedInputTokens: 1000,
      cachedInputTokens: 500,
      cacheCreationTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
    };
    // As OpenCode names it, as the usage page lists it, and as Ollama tags the cloud build.
    for (const model of [
      "ollama-cloud/gpt-oss:120b",
      "ollama-cloud/gpt-oss-120b",
      "Ollama-Cloud/GPT-OSS:120b-cloud",
    ]) {
      const priced = priceUsage(table, {
        model,
        totals: tokens,
        speed: "standard",
        reportedCostUsd: null,
      });
      assert.strictEqual(priced.costSource, "modelPriced");
      assert.closeTo(priced.costUsd, 1000 * 1e-7 + 500 * 1e-8 + 100 * 4e-7, 1e-12);
    }
  });

  it("offers a market rate under no other id, and adds nothing but Ollama Cloud's keys", () => {
    const table = withMarketRates(litellm, market);
    for (const model of [
      "gpt-oss-120b",
      "gpt-oss:120b",
      "openai/gpt-oss-120b",
      "zai/gpt-oss:120b",
      // OpenRouter's own prices are not Ollama Cloud's private ones.
      "openrouter/openai/gpt-oss-120b",
      "openrouter/gpt-oss:120b",
    ]) {
      assert.isNull(lookupRate(table, model));
    }
    assert.isNotNull(lookupRate(table, "claude-fable-5"));
    assert.deepStrictEqual(
      [...table.keys()].filter((key) => !litellm.has(key)),
      ["ollama-cloud/gpt-oss-120b"],
    );
    assert.strictEqual(table.size, litellm.size + market.size);
  });

  it("builds a merged table once, and gives the base back when there is nothing to add", () => {
    assert.strictEqual(withMarketRates(litellm, market), withMarketRates(litellm, market));
    assert.strictEqual(withMarketRates(litellm, new Map()), litellm);
  });
});

describe("withoutCatalogCost", () => {
  const rates = withMarketRates(
    new Map(),
    buildMarketRates(
      new Map([
        ["openai/gpt-oss-120b", { promptUsd: 1e-7, completionUsd: 4e-7, cacheReadUsd: null }],
      ]),
    ),
  );
  const record = (model: string, reportedCostUsd: number | null): UsageRecord => ({
    provider: "opencode",
    timestampMs: 0,
    model,
    sessionId: "session",
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
    reportedCostUsd,
    speed: "standard",
    dedupeKey: null,
  });

  it("drops OpenCode's catalog estimate where a market rate prices the model", () => {
    assert.isNull(
      withoutCatalogCost(record("ollama-cloud/gpt-oss:120b", 0.5), rates).reportedCostUsd,
    );
  });

  it("keeps it for a model the market does not price, and for other providers' models", () => {
    for (const unchanged of [
      record("ollama-cloud/qwen3:32b", 0.5),
      record("gpt-oss:120b", 0.5),
      record("ollama-cloud/gpt-oss:120b", null),
    ]) {
      assert.strictEqual(withoutCatalogCost(unchanged, rates), unchanged);
    }
  });
});
