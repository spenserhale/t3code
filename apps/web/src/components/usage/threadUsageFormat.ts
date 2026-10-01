import type { ThreadTurnUsage, ThreadUsageModel, ThreadUsageTotals } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

/** Explains the asterisk after every thread or turn cost. */
export const ESTIMATE_NOTE = "*Estimated at API prices. A subscription plan bills you differently.";

/** Cents are the smallest unit shown, so a cheap turn does not read as free. */
export function formatEstimatedUsd(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.005 ? "<$0.01" : formatUsd(costUsd);
}

export interface UsageFigures {
  /** Compact count, shown after the token icon. */
  readonly tokens: string;
  /** `null` when no model involved had a price, so the cost is unknown, not zero. */
  readonly cost: string | null;
}

export function threadUsageFigures(totals: ThreadUsageTotals): UsageFigures {
  return {
    tokens: formatTokens(totals.totalTokens),
    cost: totals.unpricedTurns >= totals.turns ? null : formatEstimatedUsd(totals.costUsd),
  };
}

export function turnUsageFigures(turn: ThreadTurnUsage): UsageFigures {
  return {
    tokens: formatTokens(turn.totalTokens),
    cost: turn.models.every((model) => model.costSource === "unpriced")
      ? null
      : formatEstimatedUsd(turn.costUsd),
  };
}

/** Where a model's share of the cost came from, in the words the Usage page uses. */
export function modelPriceSource(model: ThreadUsageModel): string {
  if (model.customPrice) return "your custom price";
  switch (model.costSource) {
    case "providerReported":
      return "reported by the provider";
    case "modelPriced":
      return "published API price";
    case "unpriced":
      return "no price known";
  }
}

/** Models with no price, which a custom price on the Usage page would fix. */
export function unpricedModels(turn: ThreadTurnUsage): readonly string[] {
  return turn.models.filter((model) => model.costSource === "unpriced").map((model) => model.model);
}
