import { assert, describe, it } from "@effect/vitest";

import type { PricedSessionRecord } from "../usage/UsageService.ts";
import { providerSessionId, rebuildTurns, type TurnWindow } from "./ThreadUsageBackfill.ts";

const at = (time: string) => Date.parse(`2026-09-01T${time}Z`);

const turn = (turnId: string, started: string, completed: string, settled = false): TurnWindow => ({
  turnId,
  startedAtMs: at(started),
  completedAt: `2026-09-01T${completed}Z`,
  settled,
});

const record = (
  time: string,
  model: string,
  outputTokens: number,
  costUsd: number | null,
): PricedSessionRecord => ({
  sessionId: "session-1",
  timestampMs: at(time),
  model,
  totals: {
    uncachedInputTokens: 10,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  },
  priced:
    costUsd === null
      ? { costUsd: 0, costSource: "unpriced" }
      : { costUsd, costSource: "modelPriced" },
});

describe("rebuildTurns", () => {
  it("gives each record to the turn running or last finished at that time", () => {
    const rebuilt = rebuildTurns(
      "thread-1",
      [turn("turn-2", "11:00:00", "11:01:00"), turn("turn-1", "10:00:00", "10:05:00")],
      [
        // Before the thread's first turn: not driven through T3 Code.
        record("09:00:00", "big-model", 900, 9),
        record("10:01:00", "big-model", 100, 1),
        // A subagent still working after turn-1 finished.
        record("10:30:00", "small-model", 5, 0.25),
        record("11:00:30", "big-model", 20, null),
      ],
    );

    assert.deepStrictEqual(
      rebuilt.map((entry) => [
        entry.turnId,
        entry.model,
        entry.totals.outputTokens,
        entry.costUsd,
        entry.costSource,
        entry.completedAt,
      ]),
      [
        ["turn-1", "big-model", 105, 1.25, "modelPriced", "2026-09-01T10:05:00Z"],
        ["turn-2", "big-model", 20, 0, "unpriced", "2026-09-01T11:01:00Z"],
      ],
    );
  });

  it("leaves a settled turn's records with it instead of handing them to a neighbour", () => {
    const rebuilt = rebuildTurns(
      "thread-1",
      [turn("turn-1", "10:00:00", "10:05:00", true), turn("turn-2", "11:00:00", "11:01:00")],
      [record("10:30:00", "big-model", 100, 1), record("11:00:30", "big-model", 20, 2)],
    );

    assert.deepStrictEqual(
      rebuilt.map((entry) => [entry.turnId, entry.costUsd]),
      [["turn-2", 2]],
    );
  });

  it("produces nothing for a turn the transcripts do not cover", () => {
    assert.deepStrictEqual(
      rebuildTurns("thread-1", [turn("turn-1", "10:00:00", "10:05:00")], []),
      [],
    );
  });
});

describe("providerSessionId", () => {
  it("reads each driver's own field and ignores drivers without transcripts", () => {
    assert.strictEqual(
      providerSessionId("claudeAgent", { resume: "claude-session" }),
      "claude-session",
    );
    assert.strictEqual(providerSessionId("codex", { threadId: "codex-session" }), "codex-session");
    assert.strictEqual(providerSessionId("grok", { sessionId: "grok-session" }), "grok-session");
    assert.isNull(providerSessionId("cursor", { sessionId: "cursor-session" }));
    assert.isNull(providerSessionId("claudeAgent", null));
  });
});
