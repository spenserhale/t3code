import { ProviderDriverKind, type UsageProviderKind } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type TokenMiss,
  cacheEnvironmentDailyTokens,
  dailyTokensByProvider,
  dailyTokensFor,
  environmentsDueForTokens,
  readDailyTokens,
  readDailyTokensFetchedAt,
  tokenRetryDelayMs,
} from "./usageLimitDailyTokens";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;

const day = (date: string, totals: Partial<Record<UsageProviderKind, number>>): DailyTotals => ({
  day: date,
  costUsd: 0,
  totalTokens: Object.values(totals).reduce((sum, tokens) => sum + tokens, 0),
  byProvider: new Map(
    Object.entries(totals).map(([provider, totalTokens]) => [
      provider as UsageProviderKind,
      { costUsd: 0, totalTokens },
    ]),
  ),
});

const account = (driver: string): LimitAccount => ({
  key: "a",
  driver: ProviderDriverKind.make(driver),
  displayName: null,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: { checkedAt: "2026-11-03T10:00:00.000Z", windows: [] },
});

describe("daily token totals for forecasts", () => {
  it("are kept by provider, without the days a provider was not used", () => {
    expect(
      dailyTokensByProvider([
        day("2026-11-01", { claude: 100, codex: 0 }),
        day("2026-11-02", { claude: 50, codex: 7 }),
      ]),
    ).toEqual({
      claude: [
        ["2026-11-01", 100],
        ["2026-11-02", 50],
      ],
      codex: [["2026-11-02", 7]],
    });
  });

  it("belong to the provider that runs an account, as its driver names it", () => {
    const stored = {
      environments: {
        desk: {
          at: 1_000,
          byProvider: {
            claude: [["2026-11-01", 100]] as const,
            codex: [["2026-11-01", 7]] as const,
          },
        },
      },
    };
    expect(dailyTokensFor(stored, account("claudeAgent"), 2_000)).toEqual([
      { day: "2026-11-01", tokens: 100 },
    ]);
    expect(dailyTokensFor(stored, account("codex"), 2_000)).toEqual([
      { day: "2026-11-01", tokens: 7 },
    ]);
    expect(dailyTokensFor(stored, account("cursor"), 2_000)).toBeUndefined();
  });

  it("add up what each environment reports, and leave out one not heard from in two weeks", () => {
    const entry = (at: number, ...days: Array<readonly [string, number]>) => ({
      at,
      byProvider: { claude: days },
    });
    const stored = {
      environments: {
        desk: entry(20 * DAY, ["2026-11-01", 100], ["2026-11-02", 5]),
        laptop: entry(20 * DAY, ["2026-11-01", 40]),
        gone: entry(0, ["2026-11-01", 1_000]),
      },
    };
    expect(dailyTokensFor(stored, account("claudeAgent"), 20 * DAY)).toEqual([
      { day: "2026-11-01", tokens: 140 },
      { day: "2026-11-02", tokens: 5 },
    ]);
    expect(dailyTokensFor(stored, account("claudeAgent"), 14 * DAY)).toHaveLength(2);
    const lone = { environments: { gone: entry(0, ["2026-11-01", 1_000]) } };
    expect(dailyTokensFor(lone, account("claudeAgent"), 14 * DAY)).toBeDefined();
    expect(dailyTokensFor(lone, account("claudeAgent"), 14 * DAY + 1)).toBeUndefined();
    expect(dailyTokensFor(null, account("claudeAgent"), 0)).toBeUndefined();
    expect(dailyTokensFor({}, account("claudeAgent"), 0)).toBeUndefined();
  });
});

describe("when each environment's token totals are fetched", () => {
  const ready = ["desk", "laptop"];
  const dueAt = (
    now: number,
    fetchedAt: Record<string, number> = {},
    misses: Map<string, TokenMiss> = new Map(),
  ) => environmentsDueForTokens({ ready, fetchedAt, misses, now });

  it("when it has none, or none from the last half day", () => {
    expect(dueAt(1_000)).toEqual(["desk", "laptop"]);
    expect(dueAt(12 * HOUR - 1, { desk: 0, laptop: 6 * HOUR })).toEqual([]);
    expect(dueAt(12 * HOUR, { desk: 0, laptop: 6 * HOUR })).toEqual(["desk"]);
  });

  it("but not while it waits out a miss, which lasts longer after each one", () => {
    const missed = new Map([["laptop", { at: 100, count: 1 }]]);
    expect(dueAt(100 + 29 * MINUTE, {}, missed)).toEqual(["desk"]);
    expect(dueAt(100 + 30 * MINUTE, { desk: 100 }, missed)).toEqual(["laptop"]);
    expect([1, 2, 3, 4, 5, 9].map(tokenRetryDelayMs)).toEqual(
      [30, 60, 120, 240, 360, 360].map((minutes) => minutes * MINUTE),
    );
  });
});

describe("the cache of fetched token totals", () => {
  const key = "t3code:usage-limit-daily-tokens:v1";
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: (name: string, value: string) => {
          values.set(name, value);
        },
      },
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps each environment's totals beside the others, dated when they came", () => {
    cacheEnvironmentDailyTokens("desk", [day("2026-11-01", { claude: 100 })], 1_000);
    cacheEnvironmentDailyTokens("laptop", [day("2026-11-01", { claude: 40 })], 2_000);
    cacheEnvironmentDailyTokens("desk", [day("2026-11-01", { claude: 110 })], 3_000);
    expect(readDailyTokensFetchedAt()).toEqual({ desk: 3_000, laptop: 2_000 });
    expect(readDailyTokens(3_000)(account("claudeAgent"))).toEqual([
      { day: "2026-11-01", tokens: 150 },
    ]);
  });

  it("reads as empty when an earlier build kept one total for everything, and is replaced", () => {
    values.set(key, JSON.stringify({ at: 1_000, byProvider: { claude: [["2026-11-01", 100]] } }));
    expect(readDailyTokensFetchedAt()).toEqual({});
    expect(readDailyTokens(2_000)(account("claudeAgent"))).toBeUndefined();
    cacheEnvironmentDailyTokens("desk", [day("2026-11-01", { claude: 7 })], 2_000);
    expect(JSON.parse(values.get(key)!)).toEqual({
      environments: { desk: { at: 2_000, byProvider: { claude: [["2026-11-01", 7]] } } },
    });
  });
});
