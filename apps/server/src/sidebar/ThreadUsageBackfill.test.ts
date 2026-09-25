import { assert, describe, it } from "@effect/vitest";

import type { SessionRecord } from "../usage/UsageService.ts";
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
  reportedCostUsd: number | null = null,
): SessionRecord => ({
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
  reportedCostUsd,
});

const summary = (turns: ReturnType<typeof rebuildTurns>) =>
  turns.map((entry) => [
    entry.turnId,
    entry.completedAt,
    entry.models.map((model) => [model.model, model.totals.outputTokens, model.reportedCostUsd]),
  ]);

describe("rebuildTurns", () => {
  it("gives each record to the turn running or last finished at that time", () => {
    const rebuilt = rebuildTurns(
      "thread-1",
      [turn("turn-2", "11:00:00", "11:01:00"), turn("turn-1", "10:00:00", "10:05:00")],
      [
        // Before the thread's first turn: not driven through T3 Code.
        record("09:00:00", "big-model", 900),
        record("10:01:00", "big-model", 100),
        // A subagent still working after turn-1 finished.
        record("10:30:00", "small-model", 5, 0.25),
        record("10:40:00", "big-model", 7),
        record("11:00:30", "big-model", 20),
      ],
    );

    assert.deepStrictEqual(summary(rebuilt), [
      [
        "turn-1",
        "2026-09-01T10:05:00Z",
        [
          ["big-model", 107, null],
          ["small-model", 5, 0.25],
        ],
      ],
      ["turn-2", "2026-09-01T11:01:00Z", [["big-model", 20, null]]],
    ]);
  });

  it("leaves a settled turn's records with it instead of handing them to a neighbour", () => {
    const rebuilt = rebuildTurns(
      "thread-1",
      [turn("turn-1", "10:00:00", "10:05:00", true), turn("turn-2", "11:00:00", "11:01:00")],
      [record("10:30:00", "big-model", 100), record("11:00:30", "big-model", 20)],
    );

    assert.deepStrictEqual(summary(rebuilt), [
      ["turn-2", "2026-09-01T11:01:00Z", [["big-model", 20, null]]],
    ]);
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
