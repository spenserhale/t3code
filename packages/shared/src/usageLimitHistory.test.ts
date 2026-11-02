import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  HISTORY_DETAIL_MS,
  HISTORY_MAX_AGE_MS,
  NO_LIMIT_HISTORY,
  RESET_TOLERANCE_MS,
  averageUtilization,
  currentLimitInstance,
  limitSamples,
  limitSeriesKey,
  pastLimitWindows,
  pruneLimitHistory,
  recordLimitSamples,
  type LimitHistory,
  type LimitSample,
} from "./usageLimitHistory.ts";
import type { LimitAccount } from "./usageLimits.ts";

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const monday = at("2026-11-02T00:00:00Z");
const reset = monday + WEEK;
const series = "claudeAgent:me@example.com|weekly:seven_day";

const sample = (offset: number, usedPercent: number, resetsAt = reset): LimitSample => ({
  series,
  at: monday + offset,
  usedPercent,
  resetsAt,
});

const record = (history: LimitHistory, ...samples: LimitSample[]) =>
  recordLimitSamples(history, samples);

function account(overrides: Partial<LimitAccount>, windows: LimitAccount["limits"]["windows"]) {
  return {
    key: "env:claude",
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: null,
    email: "me@example.com",
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: "2026-11-03T10:00:00.000Z", windows },
    ...overrides,
  } satisfies LimitAccount;
}

const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 40,
  windowDurationMins: 10_080,
  resetsAt: "2026-11-09T00:00:00.000Z",
} as const;

describe("limitSamples", () => {
  const now = at("2026-11-03T10:30:00Z");

  it("dates a reading when its provider was asked, with the series named by account and window", () => {
    expect(limitSamples([account({}, [weekly])], now)).toEqual([
      {
        series,
        at: at("2026-11-03T10:00:00Z"),
        usedPercent: 40,
        resetsAt: at("2026-11-09T00:00:00Z"),
      },
    ]);
  });

  it("never dates a reading in the future", () => {
    const skewed = account(
      { limits: { checkedAt: "2026-11-03T11:00:00.000Z", windows: [weekly] } },
      [],
    );
    expect(limitSamples([skewed], now)[0]?.at).toBe(now);
    const unreadable = account({ limits: { checkedAt: "later", windows: [weekly] } }, []);
    expect(limitSamples([unreadable], now)[0]?.at).toBe(now);
  });

  it("skips windows with no reset, a reset already passed, or no place in a burn-down", () => {
    const { resetsAt: _resetsAt, ...undated } = weekly;
    expect(
      limitSamples(
        [
          account({}, [
            undated,
            { ...weekly, id: "old", resetsAt: "2026-11-03T09:00:00.000Z" },
            { ...weekly, id: "model_quota", kind: "other" },
          ]),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it("names Codex windows by kind, because its ids are positions", () => {
    const codex = account({ driver: ProviderDriverKind.make("codex") }, []);
    expect(limitSeriesKey(codex, { id: "primary", kind: "session" })).toBe(
      "codex:me@example.com|session",
    );
    expect(limitSeriesKey(account({}, []), { id: "five_hour", kind: "session" })).toBe(
      "claudeAgent:me@example.com|session:five_hour",
    );
  });
});

describe("recordLimitSamples", () => {
  it("starts an instance with the first reading", () => {
    expect(record(NO_LIMIT_HISTORY, sample(HOUR, 10))).toEqual({
      [series]: [{ resetsAt: reset, from: monday + HOUR, readings: [[monday + HOUR, 10]] }],
    });
  });

  it("keeps the last reading of each hour", () => {
    const history = record(
      NO_LIMIT_HISTORY,
      sample(HOUR + 5 * 60_000, 10),
      sample(HOUR + 35 * 60_000, 12),
      sample(2 * HOUR + 10 * 60_000, 15),
    );
    expect(history[series]).toEqual([
      {
        resetsAt: reset,
        from: monday + HOUR + 5 * 60_000,
        readings: [
          [monday + HOUR + 35 * 60_000, 12],
          [monday + 2 * HOUR + 10 * 60_000, 15],
        ],
      },
    ]);
  });

  it("returns the same history when a reading adds nothing, and ignores older ones", () => {
    const history = record(NO_LIMIT_HISTORY, sample(HOUR, 10));
    expect(record(history, sample(HOUR + 20 * 60_000, 10))).toBe(history);
    expect(record(history, sample(HOUR, 11))).toBe(history);
    expect(record(history, sample(HOUR - 60_000, 30))).toBe(history);
    expect(record(history)).toBe(history);
  });

  it("rounds to a tenth and keeps readings within 0 to 100", () => {
    const history = record(NO_LIMIT_HISTORY, sample(HOUR, 12.34), sample(3 * HOUR, 104));
    expect(history[series]![0]!.readings).toEqual([
      [monday + HOUR, 12.3],
      [monday + 3 * HOUR, 100],
    ]);
  });

  it("follows a reset that drifts by a few seconds, and keeps naming the instance by when it began", () => {
    const history = record(
      NO_LIMIT_HISTORY,
      sample(HOUR, 10),
      sample(3 * HOUR, 20, reset + 4_000),
      sample(5 * HOUR, 30, reset + RESET_TOLERANCE_MS),
    );
    expect(history[series]).toHaveLength(1);
    expect(history[series]![0]).toMatchObject({
      from: monday + HOUR,
      resetsAt: reset + RESET_TOLERANCE_MS,
    });
  });

  it("starts a new instance when the reset moves on", () => {
    const history = record(NO_LIMIT_HISTORY, sample(HOUR, 60), sample(2 * HOUR, 5, reset + WEEK));
    expect(history[series]!.map((instance) => [instance.from, instance.resetsAt])).toEqual([
      [monday + HOUR, reset],
      [monday + 2 * HOUR, reset + WEEK],
    ]);
    const beyondJitter = record(
      NO_LIMIT_HISTORY,
      sample(HOUR, 60),
      sample(2 * HOUR, 61, reset + RESET_TOLERANCE_MS + 1),
    );
    expect(beyondJitter[series]).toHaveLength(2);
  });

  it("starts a new instance when the spend drops, as it does when a reset credit clears the window", () => {
    const cleared = record(NO_LIMIT_HISTORY, sample(HOUR, 60), sample(2 * HOUR, 0));
    expect(cleared[series]).toHaveLength(2);
    expect(cleared[series]![1]).toMatchObject({
      from: monday + 2 * HOUR,
      readings: [[monday + 2 * HOUR, 0]],
    });
    const noise = record(NO_LIMIT_HISTORY, sample(HOUR, 60), sample(2 * HOUR, 57.5));
    expect(noise[series]).toHaveLength(1);
    expect(noise[series]![0]!.readings).toEqual([
      [monday + HOUR, 60],
      [monday + 2 * HOUR, 57.5],
    ]);
  });

  it("keeps every series apart", () => {
    const other = { ...sample(HOUR, 5), series: "codex:me@example.com|weekly" };
    const history = record(NO_LIMIT_HISTORY, sample(HOUR, 10), other);
    expect(Object.keys(history)).toEqual([series, "codex:me@example.com|weekly"]);
  });
});

describe("pruneLimitHistory", () => {
  const instance = (resetsAt: number, hours: number) => ({
    resetsAt,
    from: resetsAt - WEEK,
    readings: Array.from(
      { length: hours },
      (_, hour) => [resetsAt - WEEK + hour * HOUR, hour] as const,
    ),
  });

  it("returns the same history when there is nothing to trim", () => {
    const history = { [series]: [instance(monday, 5), instance(monday + WEEK, 5)] };
    expect(pruneLimitHistory(history, monday + 3 * DAY)).toBe(history);
    expect(pruneLimitHistory(NO_LIMIT_HISTORY, monday)).toBe(NO_LIMIT_HISTORY);
  });

  it("forgets windows that ended more than 120 days ago", () => {
    const now = monday + 200 * DAY;
    const history = {
      [series]: [instance(now - HISTORY_MAX_AGE_MS - HOUR, 1), instance(now - 60 * DAY, 1)],
      "codex:x|weekly": [instance(now - 150 * DAY, 1)],
    };
    const pruned = pruneLimitHistory(history, now);
    expect(Object.keys(pruned)).toEqual([series]);
    expect(pruned[series]!.map((entry) => entry.resetsAt)).toEqual([now - 60 * DAY]);
  });

  it("keeps only the final reading of windows that ended more than two weeks ago", () => {
    const now = monday + 100 * DAY;
    const old = instance(now - HISTORY_DETAIL_MS - HOUR, 6);
    const recent = instance(now - HISTORY_DETAIL_MS + HOUR, 6);
    const pruned = pruneLimitHistory({ [series]: [old, recent] }, now);
    expect(pruned[series]![0]!.readings).toEqual([old.readings.at(-1)]);
    expect(pruned[series]![1]).toBe(recent);
  });

  it("past its size, compacts the oldest finished windows first, then drops the oldest", () => {
    const now = monday + 10 * DAY;
    const first = instance(monday + DAY, 10);
    const second = instance(monday + 3 * DAY, 10);
    const live = instance(monday + 12 * DAY, 10);
    const history = { [series]: [first, second, live] };
    const compacted = pruneLimitHistory(history, now, 22);
    expect(compacted[series]!.map((entry) => entry.readings.length)).toEqual([1, 10, 10]);
    const compactedBoth = pruneLimitHistory(history, now, 12);
    expect(compactedBoth[series]!.map((entry) => entry.readings.length)).toEqual([1, 1, 10]);
    const dropped = pruneLimitHistory(history, now, 10);
    expect(dropped[series]!.map((entry) => entry.resetsAt)).toEqual([live.resetsAt]);
    expect(Object.keys(pruneLimitHistory(history, now, 0))).toEqual([]);
  });

  it("never thins a window that is still running before it drops one that ended", () => {
    const now = monday + 10 * DAY;
    const ended = instance(monday + DAY, 10);
    const live = instance(monday + 12 * DAY, 10);
    const pruned = pruneLimitHistory({ [series]: [ended, live] }, now, 10);
    expect(pruned[series]).toEqual([live]);
  });
});

describe("past windows", () => {
  const instances = (
    ...windows: Array<[resetsAt: number, from: number, finalAt: number, used: number]>
  ) => ({
    [series]: windows.map(([resetsAt, from, finalAt, used]) => ({
      resetsAt,
      from,
      readings: [[from, 0] as const, [finalAt, used] as const],
    })),
  });

  it("finds the current instance only while its window has not ended", () => {
    const history = instances([reset, monday, monday + DAY, 10]);
    expect(currentLimitInstance(history, series, monday + 2 * DAY)?.resetsAt).toBe(reset);
    expect(currentLimitInstance(history, series, reset)).toBeNull();
    expect(currentLimitInstance(history, "nobody|weekly", monday)).toBeNull();
  });

  it("lists windows that ran to their reset with how they ended, oldest first", () => {
    const history = instances(
      [reset - 2 * WEEK, reset - 3 * WEEK, reset - 2 * WEEK - 2 * HOUR, 70],
      [reset - WEEK, reset - 2 * WEEK, reset - WEEK - 3 * DAY, 20],
      [reset, reset - WEEK, reset - HOUR, 55],
    );
    const past = pastLimitWindows(history, series, reset + HOUR, 10, WEEK);
    expect(past).toEqual([
      { resetsAt: reset - 2 * WEEK, usedPercent: 70, unseenMs: 2 * HOUR, complete: true },
      { resetsAt: reset - WEEK, usedPercent: 20, unseenMs: 3 * DAY, complete: false },
      { resetsAt: reset, usedPercent: 55, unseenMs: HOUR, complete: true },
    ]);
    expect(averageUtilization(past)).toBeCloseTo(145 / 3);
    expect(
      pastLimitWindows(history, series, reset + HOUR, 2, WEEK).map((w) => w.usedPercent),
    ).toEqual([20, 55]);
  });

  it("leaves out the window still running and the ones cleared before their reset", () => {
    const history = instances(
      // Cleared two days early: the next instance began long before this one's reset.
      [reset - WEEK, reset - 2 * WEEK, reset - WEEK - 4 * DAY, 90],
      [reset, reset - WEEK - 2 * DAY, reset - HOUR, 30],
      [reset + WEEK, reset, reset + DAY, 5],
    );
    expect(
      pastLimitWindows(history, series, reset + 2 * DAY, 10, WEEK).map((w) => w.resetsAt),
    ).toEqual([reset]);
  });

  it("has no average without windows", () => {
    expect(averageUtilization([])).toBeNull();
  });
});
