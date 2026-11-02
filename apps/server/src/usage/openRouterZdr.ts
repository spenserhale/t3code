import { ForwardCompatibleArray } from "@t3tools/contracts";
import {
  OLLAMA_CLOUD_PROVIDER_ID,
  ollamaCloudRateModel,
} from "@t3tools/provider-opencode/server/ollamaCloudMarket";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ModelRate, RateTable } from "./usagePricing.ts";

// Ollama Cloud's market price is what OpenRouter's zero-data-retention endpoints charge for the
// same model. Its rates are keyed to Ollama Cloud's ids and stay out of the LiteLLM table's alias
// step, which would offer them to every other provider.

export interface ZdrModelPrice {
  /** USD per token: the median across the model's usable endpoints. */
  readonly promptUsd: number;
  readonly completionUsd: number;
  /** Null when no usable endpoint lists a cache-read price. */
  readonly cacheReadUsd: number | null;
}

/** By OpenRouter model id, e.g. `openai/gpt-oss-120b`. */
export type ZdrPrices = ReadonlyMap<string, ZdrModelPrice>;

// A price decodes on its own so that one odd endpoint is skipped, not the whole list.
const ZdrEndpoint = Schema.Struct({
  model_id: Schema.String,
  status: Schema.Number,
  service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  safety_retention: Schema.Boolean,
  pricing: Schema.Struct({
    prompt: Schema.String,
    completion: Schema.String,
    input_cache_read: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const ZdrDocument = Schema.Struct({ data: ForwardCompatibleArray(ZdrEndpoint) });
const decodeZdrDocument = Schema.decodeUnknownOption(ZdrDocument);

function price(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The median of each price component across a model's usable endpoints: up,
 * not degraded, no priority or flex tier, and none that keeps prompts for
 * safety review. OpenRouter lists prices after any discount.
 */
export function parseZdrEndpoints(document: unknown): ZdrPrices {
  const decoded = decodeZdrDocument(document);
  const prices = new Map<string, ZdrModelPrice>();
  if (Option.isNone(decoded)) return prices;

  const endpoints = new Map<
    string,
    { prompt: number[]; completion: number[]; cacheRead: number[] }
  >();
  for (const endpoint of decoded.value.data) {
    if (endpoint.status !== 0 || endpoint.safety_retention) continue;
    if (endpoint.service_tier !== undefined && endpoint.service_tier !== null) continue;
    const prompt = price(endpoint.pricing.prompt);
    const completion = price(endpoint.pricing.completion);
    if (prompt === null || completion === null) continue;
    const entry = endpoints.get(endpoint.model_id) ?? { prompt: [], completion: [], cacheRead: [] };
    entry.prompt.push(prompt);
    entry.completion.push(completion);
    const cacheRead = price(endpoint.pricing.input_cache_read);
    if (cacheRead !== null) entry.cacheRead.push(cacheRead);
    endpoints.set(endpoint.model_id, entry);
  }
  for (const [modelId, entry] of endpoints) {
    prices.set(modelId, {
      promptUsd: median(entry.prompt),
      completionUsd: median(entry.completion),
      cacheReadUsd: entry.cacheRead.length === 0 ? null : median(entry.cacheRead),
    });
  }
  return prices;
}

/**
 * The OpenRouter model each Ollama Cloud model stands for. One not listed matches by name when a
 * single vendor has it: `gpt-oss:20b` is `openai/gpt-oss-20b`.
 */
const OPENROUTER_MODELS: ReadonlyArray<readonly [ollamaId: string, openRouterId: string]> = [
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
];

function rateOf({ promptUsd, completionUsd, cacheReadUsd }: ZdrModelPrice): ModelRate {
  return {
    inputCostPerToken: promptUsd,
    outputCostPerToken: completionUsd,
    cacheReadCostPerToken: cacheReadUsd ?? promptUsd,
    cacheCreationCostPerToken: promptUsd,
    fast: null,
    ultrafast: null,
  };
}

/**
 * Rates keyed by `ollamaCloudRateModel`. A model whose bare name two vendors
 * share is left out rather than guessed, unless the table above names it.
 */
export function buildMarketRates(prices: ZdrPrices): RateTable {
  const byName = new Map<string, string | null>();
  for (const openRouterId of prices.keys()) {
    const name = openRouterId.slice(openRouterId.indexOf("/") + 1).toLowerCase();
    byName.set(name, byName.has(name) ? null : openRouterId);
  }
  const rates = new Map<string, ModelRate>();
  for (const [name, openRouterId] of byName) {
    const found = openRouterId === null ? undefined : prices.get(openRouterId);
    if (found) rates.set(ollamaCloudRateModel(name), rateOf(found));
  }
  for (const [ollamaId, openRouterId] of OPENROUTER_MODELS) {
    const found = prices.get(openRouterId);
    if (found) rates.set(ollamaCloudRateModel(ollamaId), rateOf(found));
  }
  return rates;
}

const MARKET_PREFIX = `${OLLAMA_CLOUD_PROVIDER_ID}/`;

/**
 * LiteLLM's rates with Ollama Cloud's added. A market rate answers to the id as OpenCode and
 * Ollama spell it, `ollama-cloud/gpt-oss:120b`, as well as to its key, so a reader that has
 * only that id prices with it. No other id reaches a market rate.
 */
class RatesWithMarket extends Map<string, ModelRate> {
  override get(key: string) {
    const rate = super.get(key);
    return rate !== undefined || !key.startsWith(MARKET_PREFIX)
      ? rate
      : super.get(ollamaCloudRateModel(key.slice(MARKET_PREFIX.length)));
  }

  override has(key: string) {
    return this.get(key) !== undefined;
  }
}

// Immutable tables permit reusing one merged table, and its lookup cache, across scans.
const merged = new WeakMap<RateTable, WeakMap<RateTable, RateTable>>();

/** The rates every reader prices with: LiteLLM's, plus the market's under `ollama-cloud/`. */
export function withMarketRates(base: RateTable, market: RateTable): RateTable {
  if (market.size === 0) return base;
  let byMarket = merged.get(base);
  if (byMarket === undefined) {
    byMarket = new WeakMap();
    merged.set(base, byMarket);
  }
  let table = byMarket.get(market);
  if (table === undefined) {
    table = new RatesWithMarket([...base, ...market]);
    byMarket.set(market, table);
  }
  return table;
}

/**
 * OpenCode prices Ollama Cloud's models from a catalog, which is a list price
 * and not what the plan cost. Where a market rate exists it replaces that
 * estimate; a model with none keeps it.
 */
export function withoutCatalogCost(record: UsageRecord, rates: RateTable): UsageRecord {
  const model = record.rateModel ?? record.model;
  return record.reportedCostUsd !== null && model.startsWith(MARKET_PREFIX) && rates.has(model)
    ? { ...record, reportedCostUsd: null }
    : record;
}
