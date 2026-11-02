import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** The `providerID` OpenCode records on messages answered by Ollama Cloud. */
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";

/**
 * The key an Ollama Cloud model has in a rate table. The namespace keeps a
 * market price for Ollama's `glm-5.3` away from Z.ai's own `glm-5.3`, and the
 * id is spelled as Ollama's tags and OpenRouter's names meet: `gpt-oss:120b`
 * and `gpt-oss:120b-cloud` both become `ollama-cloud/gpt-oss-120b`.
 */
export function ollamaCloudRateModel(modelId: string): string {
  const id = modelId
    .trim()
    .toLowerCase()
    .replace(/[:-]cloud$/, "")
    .replaceAll(":", "-");
  return `${OLLAMA_CLOUD_PROVIDER_ID}/${id}`;
}

/** What Ollama billed and counted for one model over the current period. */
export interface OllamaCloudModelUsage {
  readonly model: string;
  readonly usageUsd: number;
  /** Includes the cached tokens, as Ollama reports it. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export interface OllamaCloudValueInput {
  /** Included credit the period has used, from the balance. */
  readonly usedUsd: number;
  readonly models: ReadonlyArray<OllamaCloudModelUsage>;
}

/**
 * Prices Ollama Cloud usage at OpenRouter's zero-data-retention rates. The
 * server provides it; a runtime that does not simply reports no value.
 */
export class OllamaCloudValuation extends Context.Service<
  OllamaCloudValuation,
  {
    /** What `usedUsd` of Ollama credit would cost there, or undefined when no model had a price. */
    readonly openRouterValueUsd: (
      input: OllamaCloudValueInput,
    ) => Effect.Effect<number | undefined>;
  }
>()("@t3tools/provider-opencode/server/ollamaCloudMarket/OllamaCloudValuation") {}
