import { assert, describe, it } from "@effect/vitest";
import type { TurnTokenUsage } from "@t3tools/contracts";

import {
  claudeTurnRows,
  readClaudeSessionTotals,
  turnUsageToTotals,
  usageModelId,
} from "./turnUsage.ts";

const usage = (overrides: Partial<TurnTokenUsage> = {}): TurnTokenUsage =>
  ({
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    inputTokens: 1_000,
    cachedInputTokens: 700,
    cacheCreationTokens: 100,
    outputTokens: 50,
    reasoningTokens: 20,
    ...overrides,
  }) as TurnTokenUsage;

describe("usageModelId", () => {
  it("matches the ids the usage scan records", () => {
    assert.strictEqual(usageModelId("claudeAgent", "claude-opus-5-5[1m]"), "claude-opus-5-5");
    assert.strictEqual(usageModelId("opencode", "zai-coding-plan/glm-5"), "glm-5");
    assert.strictEqual(
      usageModelId("opencode", "openrouter/anthropic/claude-sonnet-5"),
      "anthropic/claude-sonnet-5",
    );
    // Codex custom providers may name models with a slash; they keep it.
    assert.strictEqual(usageModelId("codex", " openai/gpt-oss-120b "), "openai/gpt-oss-120b");
  });
});

describe("turnUsageToTotals", () => {
  it("splits cache reads and writes out of the inclusive input count", () => {
    assert.deepStrictEqual(turnUsageToTotals(usage()), {
      uncachedInputTokens: 200,
      cachedInputTokens: 700,
      cacheCreationTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
    });
  });

  it("reports nothing for unavailable or empty usage", () => {
    assert.isNull(
      turnUsageToTotals({
        usageStatus: "unavailable",
        usageScope: "main_agent",
        hasSubagents: false,
      }),
    );
    assert.isNull(
      turnUsageToTotals(
        usage({ inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }),
      ),
    );
  });
});

describe("claudeTurnRows", () => {
  const session = (inputTokens: number, costUSD: number) =>
    readClaudeSessionTotals({ "claude-opus-5-5": { inputTokens, outputTokens: 0, costUSD } })!;

  it("takes the whole running total when the session started over", () => {
    // A lower total than last time means a restart or /clear, not negative usage.
    const rows = claudeTurnRows(session(300, 0.3), session(5_000, 5));
    assert.deepStrictEqual(
      rows.map((row) => [row.totals.uncachedInputTokens, row.reportedCostUsd]),
      [[300, 0.3]],
    );
  });

  it("skips models whose totals did not move", () => {
    assert.deepStrictEqual(claudeTurnRows(session(300, 0.3), session(300, 0.3)), []);
  });

  it("ignores entries it cannot read", () => {
    assert.isNull(readClaudeSessionTotals(null));
    assert.isNull(readClaudeSessionTotals({ "claude-opus-5-5": "oops" }));
  });
});
