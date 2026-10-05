import type { RunId, ThreadTurnUsage, ThreadUsageModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatEstimatedUsd,
  modelPriceSource,
  threadUsageFigures,
  threadUsageView,
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

const turn = (models: ThreadUsageModel[], runId: string | null = "run-1"): ThreadTurnUsage => ({
  runId: runId as RunId | null,
  completedAt: "2026-09-25T00:00:00.000Z",
  totalTokens: models.reduce((sum, entry) => sum + entry.totalTokens, 0),
  costUsd: models.reduce((sum, entry) => sum + entry.costUsd, 0),
  hasSubagents: false,
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

describe("threadUsageView", () => {
  it("totals every turn and looks a run's turn up by its id", () => {
    const priced = turn([model({ totalTokens: 250_000, costUsd: 0.14 })], "run-1");
    const unpriced = turn(
      [model({ totalTokens: 500, costUsd: 0, costSource: "unpriced" })],
      "run-2",
    );
    // A subagent thread's turn has no run, so no "Worked for" row can show it.
    const runless = turn([model({ totalTokens: 100, costUsd: 0.01 })], null);
    const view = threadUsageView([priced, unpriced, runless])!;

    expect(view.totals).toEqual({
      totalTokens: 250_600,
      costUsd: 0.15000000000000002,
      turns: 3,
      unpricedTurns: 1,
    });
    expect([...view.turns.keys()]).toEqual(["run-1", "run-2"]);
    expect(view.turns.get("run-2" as RunId)).toBe(unpriced);
  });

  it("is empty for a thread with no reported usage", () => {
    expect(threadUsageView([])).toBeNull();
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
