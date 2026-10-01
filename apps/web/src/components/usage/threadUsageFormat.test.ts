import type { ThreadTurnUsage, ThreadUsageModel, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatEstimatedUsd,
  modelPriceSource,
  threadUsageFigures,
  turnUsageFigures,
  unpricedModels,
} from "./threadUsageFormat";

const model = (overrides: Partial<ThreadUsageModel>): ThreadUsageModel => ({
  model: "example-model",
  totalTokens: 1_000,
  costUsd: 0.1,
  costSource: "modelPriced",
  customPrice: false,
  ...overrides,
});

const turn = (models: ThreadUsageModel[]): ThreadTurnUsage => ({
  turnId: "turn-1" as TurnId,
  completedAt: "2026-09-25T00:00:00.000Z",
  totalTokens: models.reduce((sum, entry) => sum + entry.totalTokens, 0),
  costUsd: models.reduce((sum, entry) => sum + entry.costUsd, 0),
  models,
});

describe("formatEstimatedUsd", () => {
  it("never shows a cheap turn as free", () => {
    expect(formatEstimatedUsd(0.004)).toBe("<$0.01");
    expect(formatEstimatedUsd(0.14)).toBe("$0.14");
    expect(formatEstimatedUsd(0)).toBe("$0.00");
  });
});

describe("usage figures", () => {
  it("shows the cost of the priced part of a turn", () => {
    expect(
      turnUsageFigures(
        turn([
          model({ totalTokens: 250_000, costUsd: 0.14 }),
          model({ model: "local-model", totalTokens: 14_000, costUsd: 0, costSource: "unpriced" }),
        ]),
      ),
    ).toEqual({ tokens: "264K", cost: "$0.14" });
  });

  it("leaves the cost out when no model had a price", () => {
    expect(turnUsageFigures(turn([model({ costUsd: 0, costSource: "unpriced" })])).cost).toBeNull();
    expect(
      threadUsageFigures({ totalTokens: 900, costUsd: 0, turns: 2, unpricedTurns: 2 }).cost,
    ).toBeNull();
  });
});

describe("modelPriceSource", () => {
  it("names a custom price before anything else", () => {
    expect(modelPriceSource(model({ customPrice: true }))).toBe("your custom price");
    expect(modelPriceSource(model({ costSource: "providerReported" }))).toBe(
      "reported by the provider",
    );
    expect(
      unpricedModels(turn([model({}), model({ model: "glm-5", costSource: "unpriced" })])),
    ).toEqual(["glm-5"]);
  });
});
