import { ProviderDriverKind, type UsageProviderKind } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { dailyTokensByProvider, dailyTokensDue, dailyTokensFor } from "./usageLimitDailyTokens";

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
      at: 1_000,
      byProvider: { claude: [["2026-11-01", 100]] as const, codex: [["2026-11-01", 7]] as const },
    };
    expect(dailyTokensFor(stored, account("claudeAgent"), 2_000)).toEqual([
      { day: "2026-11-01", tokens: 100 },
    ]);
    expect(dailyTokensFor(stored, account("codex"), 2_000)).toEqual([
      { day: "2026-11-01", tokens: 7 },
    ]);
    expect(dailyTokensFor(stored, account("cursor"), 2_000)).toBeUndefined();
  });

  it("are not trusted once two weeks old, or when nothing is cached", () => {
    const stored = { at: 0, byProvider: { claude: [["2026-11-01", 100]] as const } };
    expect(dailyTokensFor(stored, account("claudeAgent"), 14 * 24 * 3_600_000)).toBeDefined();
    expect(dailyTokensFor(stored, account("claudeAgent"), 14 * 24 * 3_600_000 + 1)).toBeUndefined();
    expect(dailyTokensFor(null, account("claudeAgent"), 0)).toBeUndefined();
  });
});

describe("when token totals are fetched", () => {
  const HOUR = 3_600_000;

  it("when there are none, or the ones kept are half a day old", () => {
    expect(dailyTokensDue({ cachedAt: null, attemptedAt: null, now: 1_000 })).toBe(true);
    expect(dailyTokensDue({ cachedAt: 0, attemptedAt: null, now: 12 * HOUR - 1 })).toBe(false);
    expect(dailyTokensDue({ cachedAt: 0, attemptedAt: null, now: 12 * HOUR })).toBe(true);
  });

  it("but not again within half an hour of a try, whether or not it brought anything", () => {
    expect(dailyTokensDue({ cachedAt: null, attemptedAt: 100, now: 100 + 29 * 60_000 })).toBe(
      false,
    );
    expect(dailyTokensDue({ cachedAt: null, attemptedAt: 100, now: 100 + 30 * 60_000 })).toBe(true);
    expect(dailyTokensDue({ cachedAt: 0, attemptedAt: 13 * HOUR, now: 13 * HOUR + 60_000 })).toBe(
      false,
    );
  });
});
