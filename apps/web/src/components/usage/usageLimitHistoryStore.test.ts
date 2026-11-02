import { ProviderDriverKind } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readUsageLimitHistory, recordUsageLimitHistory } from "./usageLimitHistoryStore";

const key = "t3code:usage-limit-history:v1";
const read = Date.parse("2026-11-03T10:00:00.000Z");
const resetsAt = Date.parse("2026-11-09T00:00:00.000Z");
const series = "claudeAgent:me@example.com|weekly:seven_day";

const account = (usedPercent: number, checkedAt: number): LimitAccount => ({
  key: "env:claude",
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: null,
  email: "me@example.com",
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: {
    checkedAt: new Date(checkedAt).toISOString(),
    windows: [
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent,
        windowDurationMins: 10_080,
        resetsAt: new Date(resetsAt).toISOString(),
      },
    ],
  },
});

let values: Map<string, string>;
let setItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
  values = new Map();
  setItem = vi.fn((name: string, value: string) => {
    values.set(name, value);
  });
  vi.stubGlobal("window", {
    localStorage: { getItem: (name: string) => values.get(name) ?? null, setItem },
    dispatchEvent: vi.fn(),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("recording Limits history", () => {
  it("stores the readings and reads them back", () => {
    const history = recordUsageLimitHistory([account(10, read)], read);
    expect(history[series]).toEqual([{ resetsAt, from: read, readings: [[read, 10]] }]);
    expect(readUsageLimitHistory()).toEqual(history);
  });

  it("writes nothing when a look adds nothing", () => {
    recordUsageLimitHistory([account(10, read)], read);
    expect(setItem).toHaveBeenCalledTimes(1);
    recordUsageLimitHistory([account(10, read)], read + 60_000);
    recordUsageLimitHistory([account(10, read + 10 * 60_000)], read + 10 * 60_000);
    expect(setItem).toHaveBeenCalledTimes(1);
    recordUsageLimitHistory([account(12, read + 2 * 3_600_000)], read + 2 * 3_600_000);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it("builds on what another window stored since this one last looked", () => {
    recordUsageLimitHistory([account(10, read)], read);
    const other = JSON.parse(values.get(key)!);
    other["codex:me@example.com|weekly"] = [{ resetsAt, from: read, readings: [[read, 5]] }];
    values.set(key, JSON.stringify(other));
    const history = recordUsageLimitHistory(
      [account(20, read + 2 * 3_600_000)],
      read + 2 * 3_600_000,
    );
    expect(Object.keys(history).sort()).toEqual([series, "codex:me@example.com|weekly"].sort());
    expect(history[series]![0]!.readings).toHaveLength(2);
  });

  it("starts over from history it cannot read", () => {
    values.set(key, "not json");
    expect(readUsageLimitHistory()).toEqual({});
    expect(recordUsageLimitHistory([account(10, read)], read)[series]).toHaveLength(1);
    values.set(key, JSON.stringify({ [series]: [{ resetsAt: "later" }] }));
    expect(readUsageLimitHistory()).toEqual({});
  });

  it("still returns the history when storage refuses the write", () => {
    setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(recordUsageLimitHistory([account(10, read)], read)[series]).toHaveLength(1);
  });
});
