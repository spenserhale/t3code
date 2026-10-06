import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type LimitAccount,
  isUsageLimitsCommand,
  collectProviderUsageLimits,
  sameUsageLimitCommandCoverage,
  withoutUsageLimitSubscriptions,
  withUsageLimitsCommands,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  displayLimitWindows,
  elapsedShare,
  formatResetsIn,
  limitsNotice,
  paceOf,
  providersWithLimits,
  remainingPercent,
  usesChatGptSharing,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("pace", () => {
  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });

  it("has no pace without a reset or a duration", () => {
    expect(paceOf({ ...window, resetsAt: undefined }, now)).toBeNull();
    expect(paceOf({ ...window, windowDurationMins: undefined }, now)).toBeNull();
    expect(formatResetsIn({ ...window, resetsAt: undefined }, now)).toBeNull();
  });

  it("phrases the reset as a countdown", () => {
    expect(formatResetsIn(window, now)).toBe("resets in 2h 0m");
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-06T15:30:00.000Z" }, now)).toBe(
      "resets in 3d 3h",
    );
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-03T11:00:00.000Z" }, now)).toBe(
      "resets now",
    );
  });
});

describe("limitsNotice", () => {
  it("explains empty bars and passes provider messages through", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    expect(limitsNotice({ checkedAt, windows: [window] })).toBeNull();
    expect(limitsNotice({ checkedAt, windows: [] })).toBe("No limits reported.");
    expect(limitsNotice({ checkedAt, windows: [], unavailable: { reason: "unsupported" } })).toBe(
      "This account has no subscription limits.",
    );
    expect(
      limitsNotice({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex timed out." },
      }),
    ).toBe("Codex timed out.");
  });
});

describe("providersWithLimits", () => {
  it("keeps only usable providers whose driver reports limits at all", () => {
    const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
    const codex = provider({ usageLimits: limits });
    expect(
      providersWithLimits([
        codex,
        provider({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
        }),
        provider({
          instanceId: ProviderInstanceId.make("off"),
          enabled: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("gone"),
          installed: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("shadow"),
          availability: "unavailable",
          usageLimits: limits,
        }),
      ]),
    ).toEqual([codex]);
  });
});

describe("pools", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const claude = ProviderDriverKind.make("claudeAgent");
  const source = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
  };
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("merges one account reported natively on two environments and by a hub into one entry", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "Same@example.com" },
      usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 40 }] },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [native] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...native,
                usageLimits: {
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, usedPercent: 55 }],
                },
              },
            ],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    plan: "Claude Subscription",
                    usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 10 }] },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      key: "env-a:claude",
      sourceLabel: null,
      // Desktop's read is fresher, so its credits and its redeem are the ones on show.
      redeem: { environmentId: "env-b", input: { instanceId: "claude" } },
      environments: [
        { environmentId: "env-a", label: "Laptop" },
        { environmentId: "env-b", label: "Desktop" },
      ],
    });
    // The fresher native snapshot wins; the hub row is pre-filtered by email.
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(55);
  });

  it("merges OpenCode Go limits from machines with the same API key", () => {
    const go = provider({
      driver: ProviderDriverKind.make("opencode"),
      instanceId: ProviderInstanceId.make("opencode"),
      auth: { status: "authenticated" },
      usageLimits: {
        checkedAt,
        credentialFingerprint: "shared-go-key",
        windows: [{ ...window, id: "go_rolling", usedPercent: 3 }],
      },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [go] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...go,
                usageLimits: {
                  ...go.usageLimits!,
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, id: "go_rolling", usedPercent: 4 }],
                },
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
      { environmentId: "env-b", label: "Desktop" },
    ]);
    expect(collectLimitPools(accounts, now)[0]?.windows[0]?.members).toHaveLength(1);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(4);

    const differentKey = {
      ...go,
      usageLimits: { ...go.usageLimits!, credentialFingerprint: "other-go-key" },
    };
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [differentKey] },
    });
    expect(collectLimitAccounts(input)).toHaveLength(2);

    input.set(EnvironmentId.make("env-a"), {
      ...laptop,
      serverConfig: {
        providers: [{ ...go, auth: { status: "authenticated", email: "same@example.com" } }],
      },
    });
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: {
        providers: [
          { ...differentKey, auth: { status: "authenticated", email: "SAME@example.com" } },
        ],
      },
    });
    expect(collectLimitAccounts(input)).toHaveLength(1);
  });

  it("takes windows from a fresher hub read but credits and redeem from the native instance", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [{ ...window, usedPercent: 40 }],
        resetCredits: { availableCount: 2 },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    usageLimits: {
                      checkedAt: "2026-09-03T11:30:00.000Z",
                      windows: [{ ...window, usedPercent: 55 }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.windows[0]?.usedPercent).toBe(55);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-a", input: { instanceId: "claude" } });
    expect(account?.environments).toEqual([{ environmentId: "env-a", label: "Laptop" }]);
  });

  it("redeems through the hub when it holds a credit, even with a fresher native read", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [{ ...window, usedPercent: 40 }],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 55 }],
                      resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    // Only the hub path clears the routing cooldown it holds for this account.
    expect(account?.redeem).toEqual({
      environmentId: "env-a",
      input: { sourceId: "hub", accountId: "claude-same@example.com.json", creditId: "hub-credit" },
    });
    // The fresher native balance is still the one shown.
    expect(account?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("redeems on the environment whose snapshot supplied the credits on show", () => {
    const stale = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 0 },
      },
    });
    const fresh = {
      ...stale,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2 },
      },
    };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [stale] } }],
      [
        EnvironmentId.make("env-b"),
        { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [fresh] } },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-b", input: { instanceId: "codex" } });
  });

  it("uses the freshest hub credit and its environment even when the account is also native", () => {
    const native = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: { checkedAt, windows: [window], resetCredits: { availableCount: 1 } },
    });
    const hubAccount = {
      id: "codex-same.json",
      driver: native.driver,
      email: "same@example.com",
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2, nextCreditId: "credit-2" },
      },
    };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [native] } }],
      [
        EnvironmentId.make("env-b"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: [hubAccount] }],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({
      environmentId: "env-b",
      input: { sourceId: "hub", accountId: "codex-same.json", creditId: "credit-2" },
    });
    hubAccount.usageLimits.resetCredits.availableCount = 0;
    expect(collectLimitAccounts(input)[0]?.limits.resetCredits?.availableCount).toBe(0);
  });

  it("keeps distinct hub accounts redeemable through their own source", () => {
    const hubAccounts = ["first", "second"].map((id) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      email: `${id}@example.com`,
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 2, nextCreditId: `${id}-credit` },
      },
    }));
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: hubAccounts }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(input).map((account) => account.redeem)).toEqual(
      hubAccounts.map((account) => ({
        environmentId: "env-a",
        input: { sourceId: "hub", accountId: account.id, creditId: `${account.id}-credit` },
      })),
    );
  });

  it("does not give old credits the timestamp of a newer window-only read", () => {
    const snapshots = [
      { checkedAt, windows: [window], resetCredits: { availableCount: 2 } },
      { checkedAt: "2026-09-03T12:00:00.000Z", windows: [window] },
      {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 1 },
      },
    ];
    const input = new Map(
      snapshots.map((usageLimits, i) => [
        EnvironmentId.make(`env-${i}`),
        {
          ...laptop,
          serverConfig: {
            providers: [
              provider({
                auth: { status: "authenticated", email: "same@example.com" },
                usageLimits,
              }),
            ],
          },
        },
      ]),
    );
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.checkedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(account?.limits.resetCredits?.availableCount).toBe(1);
    expect(account?.redeem?.environmentId).toBe("env-2");
  });

  it("names an environment once however many of its instances share the account", () => {
    const shared = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [shared, { ...shared, instanceId: ProviderInstanceId.make("work") }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(input)[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
    ]);
  });

  it("keys a hub account without an email by hub, so two environments on one hub share it", () => {
    const seat = {
      id: "claude-team-seat.json",
      driver: claude,
      usageLimits: { checkedAt, windows: [window] },
    };
    const hub = { ...source, accounts: [seat] };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { usageLimitSources: [hub] } }],
      [
        EnvironmentId.make("env-b"),
        { entry: { target: { label: "Desktop" } }, serverConfig: { usageLimitSources: [hub] } },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts.map((account) => account.key)).toEqual(["hub:claude-team-seat.json"]);
    expect(accounts[0]?.displayName).toBe("claude-team-seat");
  });

  it("pools windows by id across accounts and orders resets by when they land", () => {
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "a",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [
                        { ...window, usedPercent: 80, resetsAt: "2026-09-03T13:00:00.000Z" },
                        { ...weekly, usedPercent: 20 },
                      ],
                    },
                  },
                  {
                    id: "b",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 40 }],
                    },
                  },
                  {
                    id: "c",
                    driver: ProviderDriverKind.make("codex"),
                    usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] },
                  },
                  {
                    id: "unsupported",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [],
                      unavailable: { reason: "unsupported" as const },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const pools = collectLimitPools(collectLimitAccounts(input), now);
    expect(pools.map((pool) => [pool.driver, pool.accounts.length])).toEqual([
      ["claudeAgent", 2],
      ["codex", 1],
    ]);
    const [session, week] = pools[0]!.windows;
    // A member with no reset has no clock, so it does not vote on pace.
    const untimed = collectLimitPools(
      collectLimitAccounts(input).map((account) =>
        account.key === "hub:b"
          ? {
              ...account,
              limits: {
                ...account.limits,
                windows: account.limits.windows.map((w) => ({ ...w, resetsAt: undefined })),
              },
            }
          : account,
      ),
      now,
    );
    // Only a votes: 80% used, 80% elapsed.
    expect(untimed[0]?.windows[0]?.pace).toBe("on");
    // a is 80% through its window and b 60%: the pool is 70% elapsed, 60% used.
    expect(session).toMatchObject({
      id: "five_hour",
      remainingPercent: 40,
      usedPercent: 60,
      pace: "under",
    });
    expect(
      session?.resets.map((reset) => [reset.member.account.key, reset.restoresPercent]),
    ).toEqual([
      ["hub:a", 40],
      ["hub:b", 20],
    ]);
    expect(week).toMatchObject({ id: "seven_day", remainingPercent: 80, members: [{}] });
    // Codex reports `primary` for both its five-hour and (on Go) monthly window.
    const mixed = collectLimitPools(
      [
        ...collectLimitAccounts(input),
        {
          key: "go",
          driver: claude,
          displayName: "Go",
          email: undefined,
          plan: undefined,
          accentColor: undefined,
          environments: [],
          sourceLabel: null,
          redeem: null,
          limits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "monthly",
                label: "Monthly",
                usedPercent: 82,
                windowDurationMins: 30 * 24 * 60,
                resetsAt: "2026-09-14T12:00:00.000Z",
              },
            ],
          },
        },
      ],
      now,
    );
    expect(mixed[0]?.windows.map((window) => [window.kind, window.members.length])).toEqual([
      ["session", 2],
      ["weekly", 1],
      ["monthly", 1],
    ]);
    // Session resets determine the account order for every row.
    expect(session?.members.map((member) => member.account.key)).toEqual(["hub:a", "hub:b"]);
    expect(pools[0]?.accounts.map((account) => account.key)).toEqual(["hub:a", "hub:b"]);
  });
});

describe("pooled account columns", () => {
  const weekly = {
    ...window,
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
  } as const;
  const account = (key: string, windows: LimitAccount["limits"]["windows"]): LimitAccount => ({
    key,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: "Hub",
    redeem: null,
    limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
  });
  const keys = (pool: ReturnType<typeof collectLimitPools>[number]) =>
    pool.windows.map((row) =>
      row.columns.map((member) => (member.window ? member.account.key : null)),
    );

  it("keeps session columns across rows with opposite reset and usage orders", () => {
    const accounts = [
      account("a", [
        { ...weekly, usedPercent: 80, resetsAt: "2026-09-05T12:00:00.000Z" },
        { ...window, usedPercent: 10, resetsAt: "2026-09-03T15:00:00.000Z" },
      ]),
      account("b", [
        { ...weekly, usedPercent: 20, resetsAt: "2026-09-06T12:00:00.000Z" },
        { ...window, usedPercent: 90, resetsAt: "2026-09-03T13:00:00.000Z" },
      ]),
    ];
    const [pool] = collectLimitPools(accounts, now);
    expect(pool!.accounts.map((account) => account.key)).toEqual(["b", "a"]);
    expect(keys(pool!)).toEqual([
      ["b", "a"],
      ["b", "a"],
    ]);
    expect(pool!.windows[1]!.resets.map((reset) => reset.member.account.key)).toEqual(["a", "b"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(50);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual(keys(pool!));
  });

  it("preserves gaps without counting missing windows toward pooled quota", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [window]),
        account("b", [
          { ...window, resetsAt: "2026-09-03T15:00:00.000Z" },
          { ...weekly, usedPercent: 80 },
        ]),
        account("c", [weekly]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([
      ["a", "b", null],
      [null, "b", "c"],
    ]);
    expect(pool!.windows[1]!.members.map((member) => member.account.key)).toEqual(["b", "c"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(40);
    expect(pool!.windows[1]!.resets.map((reset) => reset.restoresPercent)).toEqual([40, 20]);
  });

  it("falls back to weekly resets when no account reports a session", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [{ ...weekly, resetsAt: "2026-09-06T12:00:00.000Z" }]),
        account("b", [{ ...weekly, resetsAt: "2026-09-05T12:00:00.000Z" }]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([["b", "a"]]);
  });

  it("sorts unknown resets last and breaks ties consistently", () => {
    const accounts = [
      account("z", [{ ...window, resetsAt: undefined }]),
      account("b", [window]),
      account("a", [window]),
      account("y", [{ ...window, resetsAt: "invalid" }]),
    ];
    expect(keys(collectLimitPools(accounts, now)[0]!)).toEqual([["a", "b", "y", "z"]]);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual([["a", "b", "y", "z"]]);
  });
});

describe("subscriptions of one provider account", () => {
  const earlier = "2026-09-03T11:00:00.000Z";
  const later = "2026-09-03T11:30:00.000Z";
  const zaiWindow = { ...window, id: "zai_five_hour", label: "Z.ai · 5 hours" };
  const ollamaWindow = {
    id: "ollama_monthly",
    kind: "monthly",
    label: "Ollama · Monthly",
    usedPercent: 20,
  } as const;
  const goWindow = { ...window, id: "go_rolling", label: "Go · Session" };
  const zai = {
    id: "zai-coding-plan",
    label: "Z.ai",
    credentialFingerprint: "zai-key",
    checkedAt: earlier,
    windowIds: ["zai_five_hour"],
  };
  const ollama = {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    credentialFingerprint: "ollama-key",
    checkedAt: earlier,
    windowIds: ["ollama_monthly"],
  };
  const instance = {
    driver: ProviderDriverKind.make("opencode"),
    instanceId: ProviderInstanceId.make("opencode"),
  };
  const opencode = (
    usageLimits: Partial<NonNullable<ServerProvider["usageLimits"]>>,
    overrides: Partial<ServerProvider> = {},
  ) =>
    provider({
      ...instance,
      // The account as a whole is named by its set of credentials and is as old as its oldest read.
      usageLimits: {
        checkedAt: earlier,
        windows: [zaiWindow, ollamaWindow],
        credentialFingerprint: "zai-key+ollama-key",
        subscriptions: [zai, ollama],
        ...usageLimits,
      },
      ...overrides,
    });
  /** What a server that does not list subscriptions publishes: one account under one identity. */
  const unlisted = (
    credentialFingerprint: string,
    windows: NonNullable<ServerProvider["usageLimits"]>["windows"],
    overrides: Partial<ServerProvider> = {},
  ) =>
    provider({
      ...instance,
      usageLimits: { checkedAt: earlier, windows, credentialFingerprint },
      ...overrides,
    });
  const zaiOnly = opencode({
    windows: [zaiWindow],
    credentialFingerprint: "zai-key",
    subscriptions: [zai],
  });
  const environments = (providers: Record<string, ServerProvider>) =>
    new Map(
      Object.entries(providers).map(([label, entry]) => [
        EnvironmentId.make(label),
        { entry: { target: { label } }, serverConfig: { providers: [entry] } },
      ]),
    );
  const signedIn = (account: LimitAccount) => account.environments.map(({ label }) => label);
  const columns = (accounts: readonly LimitAccount[]) =>
    Object.fromEntries(
      collectLimitPools(accounts, now)[0]!.windows.map((row) => [
        row.id,
        row.columns.map((column) => (column.window ? column.account.displayName : null)),
      ]),
    );

  it("counts a subscription once, whatever else each environment is signed in to", () => {
    const accounts = collectLimitAccounts(
      environments({ A: opencode({}), B: opencode({}), C: zaiOnly }),
    );
    expect(
      accounts.map((account) => [account.displayName, account.subscription, signedIn(account)]),
    ).toEqual([
      ["Z.ai", "zai-coding-plan", ["A", "B", "C"]],
      ["Ollama Cloud", "ollama-cloud", ["A", "B"]],
    ]);
    expect(accounts.map((account) => account.limits.windows)).toEqual([
      [zaiWindow],
      [ollamaWindow],
    ]);
    const [pool] = collectLimitPools(accounts, now);
    expect(pool!.windows.map((row) => [row.id, row.members.length, row.usedPercent])).toEqual([
      ["zai_five_hour", 1, 40],
      ["ollama_monthly", 1, 20],
    ]);
  });

  it("takes each subscription from the environment that read it last", () => {
    const accounts = collectLimitAccounts(
      environments({
        A: opencode({
          windows: [
            { ...zaiWindow, usedPercent: 50 },
            { ...ollamaWindow, usedPercent: 10 },
          ],
          subscriptions: [{ ...zai, checkedAt: later }, ollama],
        }),
        B: opencode({
          windows: [
            { ...zaiWindow, usedPercent: 45 },
            { ...ollamaWindow, usedPercent: 30 },
          ],
          subscriptions: [zai, { ...ollama, checkedAt: later }],
        }),
      }),
    );
    expect(
      accounts.map(({ limits }) => [limits.checkedAt, limits.windows[0]?.usedPercent]),
    ).toEqual([
      [later, 50],
      [later, 30],
    ]);
  });

  it("offers reset credits on the subscription that banks them", () => {
    const resetCredits = { availableCount: 1, nextCreditId: "WEEK:22" };
    const accounts = collectLimitAccounts(
      environments({
        // A's reset list was down, so only B knows of the credit.
        A: opencode({ subscriptions: [{ ...zai, checkedAt: later }, ollama] }),
        B: opencode({ resetCredits, subscriptions: [{ ...zai, resetCredits }, ollama] }),
      }),
    );
    expect(accounts.map(({ redeem, limits }) => [redeem, limits.resetCredits])).toEqual([
      [{ environmentId: "B", input: { instanceId: "opencode" } }, resetCredits],
      [null, undefined],
    ]);
  });

  it("names each account by its subscription, after the instance's own name", () => {
    const accounts = collectLimitAccounts(
      environments({ A: opencode({}, { displayName: " Work " }) }),
    );
    expect(accounts.map((account) => [account.key, account.displayName])).toEqual([
      ["A:opencode:zai-key", "Work · Z.ai"],
      ["A:opencode:ollama-key", "Work · Ollama Cloud"],
    ]);
  });

  it("keeps windows no subscription claims on an account for the instance", () => {
    const accounts = collectLimitAccounts(
      environments({
        A: opencode({
          windows: [goWindow, zaiWindow],
          credentialFingerprint: "zai-key",
          // Ollama answered with no window this client can draw.
          subscriptions: [zai, ollama],
        }),
      }),
    );
    expect(
      accounts.map((account) => [account.key, account.subscription, account.limits.windows]),
    ).toEqual([
      ["A:opencode:zai-key", "zai-coding-plan", [zaiWindow]],
      ["A:opencode", undefined, [goWindow]],
    ]);
  });

  it("gives a window to the first subscription that claims it", () => {
    const accounts = collectLimitAccounts(
      environments({
        A: opencode({
          windows: [zaiWindow],
          subscriptions: [zai, { ...ollama, windowIds: ["zai_five_hour", "ollama_monthly"] }],
        }),
      }),
    );
    expect(accounts.map((account) => [account.displayName, account.limits.windows])).toEqual([
      ["Z.ai", [zaiWindow]],
    ]);
  });

  it("keeps two keys of one plan apart", () => {
    const otherZai = {
      ...zai,
      credentialFingerprint: "other-zai-key",
      windowIds: ["zai_weekly"],
    };
    const zaiWeekly = {
      ...zaiWindow,
      id: "zai_weekly",
      kind: "weekly",
      label: "Z.ai · Weekly",
    } as const;
    const accounts = collectLimitAccounts(
      environments({
        A: opencode({ windows: [zaiWindow, zaiWeekly], subscriptions: [zai, otherZai] }),
      }),
    );
    expect(
      accounts.map((account) => [account.key, account.limits.windows.map(({ id }) => id)]),
    ).toEqual([
      ["A:opencode:zai-key", ["zai_five_hour"]],
      ["A:opencode:other-zai-key", ["zai_weekly"]],
    ]);
  });

  it("keeps the first of two subscriptions with one credential", () => {
    const accounts = collectLimitAccounts(
      environments({
        A: opencode({
          subscriptions: [zai, { ...ollama, credentialFingerprint: "zai-key" }],
        }),
      }),
    );
    // The later entry is dropped, so its window is left for the instance.
    expect(
      accounts.map((account) => [account.key, account.subscription, account.limits.windows]),
    ).toEqual([
      ["A:opencode:zai-key", "zai-coding-plan", [zaiWindow]],
      ["A:opencode", undefined, [ollamaWindow]],
    ]);
  });

  it("keeps reset credits no subscription carries on the account for the instance", () => {
    const resetCredits = { availableCount: 1, nextCreditId: "WEEK:22" };
    const redeem = { environmentId: "A", input: { instanceId: "opencode" } };
    const fleet = (subscriptions: NonNullable<ServerProvider["usageLimits"]>["subscriptions"]) =>
      collectLimitAccounts(
        environments({
          A: opencode({ windows: [zaiWindow, goWindow], resetCredits, subscriptions }),
        }),
      ).map(({ key, redeem: target, limits }) => [key, target, limits.resetCredits]);
    expect(fleet([zai])).toEqual([
      ["A:opencode:zai-key", null, undefined],
      ["A:opencode", redeem, resetCredits],
    ]);
    expect(fleet([{ ...zai, resetCredits }])).toEqual([
      ["A:opencode:zai-key", redeem, resetCredits],
      ["A:opencode", null, undefined],
    ]);
  });

  it("offers a reset credit once when one environment skips the entry that carries it", () => {
    const resetCredits = { availableCount: 1, nextCreditId: "WEEK:22" };
    const repeat = { ...ollama, credentialFingerprint: "zai-key", resetCredits };
    const accounts = collectLimitAccounts(
      environments({
        // The credit sits on an entry A skips for repeating a credential; B lists that entry alone.
        A: opencode({ resetCredits, subscriptions: [zai, repeat] }),
        B: opencode({
          windows: [ollamaWindow],
          resetCredits,
          credentialFingerprint: "zai-key",
          subscriptions: [repeat],
        }),
      }),
    );
    expect(accounts.filter(({ redeem }) => redeem)).toHaveLength(1);
    expect(accounts.filter(({ limits }) => limits.resetCredits)).toHaveLength(1);
  });

  it("matches a server that reports the same credential as one plain account", () => {
    const older = unlisted("zai-key", [zaiWindow]);
    for (const fleet of [
      { Old: older, New: zaiOnly },
      { New: zaiOnly, Old: older },
    ]) {
      const accounts = collectLimitAccounts(environments(fleet));
      expect(
        accounts.map((account) => [account.displayName, account.subscription, signedIn(account)]),
      ).toEqual([["Z.ai", "zai-coding-plan", Object.keys(fleet)]]);
    }
  });

  it("gives a window a column for each account on its plan and no other", () => {
    const otherZai = opencode({
      windows: [{ ...zaiWindow, usedPercent: 60 }],
      credentialFingerprint: "other-zai-key",
      subscriptions: [{ ...zai, label: "Z.ai (other)", credentialFingerprint: "other-zai-key" }],
    });
    expect(columns(collectLimitAccounts(environments({ A: opencode({}), B: otherZai })))).toEqual({
      zai_five_hour: ["Z.ai", "Z.ai (other)"],
      ollama_monthly: ["Ollama Cloud"],
    });
  });

  it("keeps a gap for an account that could report the window", () => {
    const weeklyWindow = { ...goWindow, id: "go_weekly", kind: "weekly" } as const;
    const accounts = collectLimitAccounts(
      environments({
        A: zaiOnly,
        B: unlisted("go-key", [goWindow, weeklyWindow], { displayName: "both" }),
        C: unlisted("other-go-key", [weeklyWindow], { displayName: "weekly" }),
      }),
    );
    expect(columns(accounts)).toEqual({
      zai_five_hour: ["Z.ai"],
      go_rolling: ["both", null],
      go_weekly: ["both", "weekly"],
    });
  });
});

describe("Cursor limit presentation", () => {
  const cursorAccount: LimitAccount = {
    key: "cursor",
    driver: ProviderDriverKind.make("cursor"),
    displayName: "Cursor",
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: "Cursor",
    redeem: null,
    limits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [
        { id: "apiPercentUsed", kind: "monthly", label: "Other Models", usedPercent: 49 },
        { id: "autoPercentUsed", kind: "monthly", label: "Cursor Models", usedPercent: 9 },
        { id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 15 },
      ],
    },
  };

  it("hides the combined percentage and orders the two pools", () => {
    const [pool] = collectLimitPools([cursorAccount], now);
    const display = displayLimitWindows(pool!);
    expect(display.map((window) => window.id)).toEqual(["autoPercentUsed", "apiPercentUsed"]);
  });

  it("keeps the combined percentage as a card if either allowance is missing", () => {
    const [pool] = collectLimitPools(
      [
        {
          ...cursorAccount,
          limits: {
            ...cursorAccount.limits,
            windows: cursorAccount.limits.windows.filter(
              (window) => window.id !== "apiPercentUsed",
            ),
          },
        },
      ],
      now,
    );
    const display = displayLimitWindows(pool!);
    expect(display.map((window) => window.id)).toEqual(["totalPercentUsed", "autoPercentUsed"]);
  });
});

describe("collectLimitNotices", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const claude = ProviderDriverKind.make("claudeAgent");
  const laptop = { entry: { target: { label: "Laptop" } } };
  const hub = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
    accounts: [],
  };

  it("names failures and silence, skips unsupported accounts, and labels environments only when several", () => {
    const failed = provider({
      instanceId: ProviderInstanceId.make("claude"),
      driver: claude,
      displayName: "Claude Max",
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
    });
    const apiKey = provider({
      instanceId: ProviderInstanceId.make("api"),
      driver: claude,
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
    });
    const silent = provider({ usageLimits: { checkedAt, windows: [] } });
    const one = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [failed, apiKey, silent],
            usageLimitSources: [
              hub,
              { ...hub, id: UsageLimitSourceId.make("down"), label: "down", error: "ECONNREFUSED" },
            ],
          },
        },
      ],
    ]);
    expect(collectLimitNotices(one)).toEqual([
      "Claude Max: Could not read limits.",
      "codex: No limits reported.",
      "hub: No accounts reported.",
      "down: ECONNREFUSED",
    ]);

    one.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [], usageLimitSources: [] },
    });
    expect(collectLimitNotices(one)[0]).toBe("Laptop · Claude Max: Could not read limits.");
  });
});

describe("/usage-limits", () => {
  const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });
  const sources = [
    {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "Accounts",
      checkedAt: limits.checkedAt,
      accounts: [
        {
          id: "duplicate",
          driver: selected.driver,
          email: "SAME@example.com",
          usageLimits: limits,
        },
        { id: "oss", driver: selected.driver, plan: "Codex OSS", usageLimits: limits },
        { id: "other-provider", driver: ProviderDriverKind.make("claude"), usageLimits: limits },
      ],
    },
  ];

  it("uses hub credit balances and redemption targets in the composer, including native duplicates", () => {
    const hubs = sources.map((source) => ({
      ...source,
      accounts: source.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          resetCredits: { availableCount: 2, nextCreditId: `${account.id}-credit` },
        },
      })),
    }));
    const report = collectProviderUsageLimits(selected.instanceId, [selected], hubs, now);
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(2);
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "duplicate-credit",
    });
    expect(report?.accounts.find((account) => account.id === "hub:oss")?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "oss",
      creditId: "oss-credit",
    });
  });

  it("redeems a native duplicate through the hub even when the native snapshot is fresher", () => {
    const fresher = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
      auth: { status: "authenticated", email: "same@example.com" },
    });
    const stale = [
      {
        id: UsageLimitSourceId.make("hub"),
        kind: "cliproxy" as const,
        label: "Accounts",
        checkedAt: limits.checkedAt,
        accounts: [
          {
            id: "duplicate",
            driver: fresher.driver,
            email: "SAME@example.com",
            usageLimits: {
              ...limits,
              resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
            },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(fresher.instanceId, [fresher], stale, now);
    // Only redeeming through the hub clears the routing cooldown it holds for
    // this account, so the hub wins the path even with a staler balance.
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "hub-credit",
    });
    // The fresher native balance is still the one shown.
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("keeps accounts and custom instances separate, filtering by driver", () => {
    const report = collectProviderUsageLimits(
      selected.instanceId,
      [
        selected,
        provider({
          instanceId: ProviderInstanceId.make("codex-work"),
          displayName: "Work",
          usageLimits: { ...limits, resetCredits: { availableCount: 2 } },
        }),
        provider({
          driver: ProviderDriverKind.make("claude"),
          instanceId: ProviderInstanceId.make("claude"),
          usageLimits: limits,
        }),
      ],
      sources,
      now,
    );
    expect(report?.createdAt).toBe("2026-09-03T12:00:00.000Z");
    expect(report?.accounts.map((account) => account.id)).toEqual([
      "codex",
      "codex-work",
      "hub:oss",
    ]);
    expect(report?.accounts[0]).toMatchObject({
      instanceId: selected.instanceId,
      email: selected.auth.email,
    });
    expect(report?.accounts[1]).toMatchObject({
      displayName: "Work",
      limits: { resetCredits: { availableCount: 2 } },
    });
    expect(report?.accounts[2]).toMatchObject({
      label: "Accounts · oss",
      sourceLabel: "CLI Proxy",
      plan: "Codex OSS",
    });
    expect(report?.notices).toEqual([]);
  });

  it("supports a source-only provider and keeps duplicates when the native probe failed", () => {
    expect(
      collectProviderUsageLimits(selected.instanceId, [provider({})], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["hub:duplicate", "hub:oss"]);
    const failed = provider({ usageLimits: { ...limits, unavailable: { reason: "probeFailed" } } });
    expect(
      collectProviderUsageLimits(selected.instanceId, [failed], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["codex", "hub:duplicate", "hub:oss"]);
    expect(collectProviderUsageLimits(selected.instanceId, [provider({})], [], now)).toBeNull();
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [provider({ enabled: false, usageLimits: limits })],
        [],
        now,
      ),
    ).toBeNull();
  });

  it("surfaces source errors only for sources that carry the selected driver", () => {
    const failing = { ...sources[0]!, error: "token expired" };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [failing], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    const claudeOnly = { ...failing, accounts: failing.accounts.slice(2) };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [claudeOnly], now)?.notices,
    ).toEqual([]);
    // A read failure clears the accounts, so the error must not depend on a match.
    const unreadable = { ...failing, accounts: [] };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [unreadable], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    // A source-only provider still gets the report, carrying only the error.
    const sourceOnly = collectProviderUsageLimits(
      selected.instanceId,
      [provider({})],
      [unreadable],
      now,
    );
    expect(sourceOnly?.accounts).toEqual([]);
    expect(sourceOnly?.notices).toEqual(["Accounts: token expired"]);
  });

  it("advertises global and workspace commands only for providers present in Limits", () => {
    const withWorkspace = provider({
      workspaceSnapshots: [
        { cwd: "/tmp/project", checkedAt: limits.checkedAt, slashCommands: [], skills: [] },
      ],
    });
    const [supported] = withUsageLimitsCommands([withWorkspace], sources);
    expect(supported?.slashCommands.map((command) => command.name)).toEqual(["usage-limits"]);
    expect(
      supported?.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
    expect(withUsageLimitsCommands([withWorkspace], [])[0]?.slashCommands).toEqual([]);
    // A provider's own command of the same name is left alone without coverage.
    const ownCommand = provider({
      slashCommands: [{ name: "usage-limits", description: "Provider's own" }],
    });
    expect(withUsageLimitsCommands([ownCommand], [])[0]?.slashCommands).toEqual([
      { name: "usage-limits", description: "Provider's own" },
    ]);
    const unreadable = { ...sources[0]!, accounts: [], error: "token expired" };
    expect(
      withUsageLimitsCommands([withWorkspace], [unreadable])[0]?.slashCommands.map(
        (command) => command.name,
      ),
    ).toEqual(["usage-limits"]);
    expect(
      withUsageLimitsCommands([selected], [])[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
  });
});

describe("sameUsageLimitCommandCoverage", () => {
  const codexAccount = {
    id: "a",
    driver: ProviderDriverKind.make("codex"),
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] },
  };
  const base = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "Accounts",
    checkedAt: "2026-09-03T11:00:00.000Z",
  };
  it("ignores quota movement but not the drivers offered the command", () => {
    const withCodex = [{ ...base, accounts: [codexAccount] }];
    const withCodexLater = [
      {
        ...base,
        accounts: [
          {
            ...codexAccount,
            usageLimits: { ...codexAccount.usageLimits, checkedAt: "2026-09-03T12:00:00.000Z" },
          },
        ],
      },
    ];
    expect(sameUsageLimitCommandCoverage(withCodex, withCodexLater)).toBe(true);
    expect(sameUsageLimitCommandCoverage(withCodex, [{ ...base, accounts: [] }])).toBe(false);
  });
  it("treats a failed read as a change in coverage, in both directions", () => {
    const empty = [{ ...base, accounts: [] }];
    const failed = [{ ...base, accounts: [], error: "token expired" }];
    expect(sameUsageLimitCommandCoverage(empty, failed)).toBe(false);
    expect(sameUsageLimitCommandCoverage(failed, empty)).toBe(false);
    expect(
      sameUsageLimitCommandCoverage(failed, [{ ...base, accounts: [], error: "still down" }]),
    ).toBe(true);
  });
});

describe("withoutUsageLimitSubscriptions", () => {
  const subscription = {
    id: "zai-coding-plan",
    label: "Z.ai",
    credentialFingerprint: "zai-key",
    checkedAt: "2026-09-03T11:00:00.000Z",
    windowIds: ["zai_five_hour"],
  };
  const listed = provider({
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [window],
      credentialFingerprint: "zai-key",
      resetCredits: { availableCount: 1 },
      subscriptions: [subscription],
    },
  });

  it("drops the subscriptions and nothing else", () => {
    const [stripped] = withoutUsageLimitSubscriptions([listed]);
    expect(stripped?.usageLimits).toEqual({
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [window],
      credentialFingerprint: "zai-key",
      resetCredits: { availableCount: 1 },
    });
    expect(stripped).toEqual({ ...listed, usageLimits: stripped?.usageLimits });
    expect(listed.usageLimits?.subscriptions).toEqual([subscription]);
  });

  it("returns what it was given when there is nothing to drop", () => {
    const plain = [
      provider({}),
      provider({ usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] } }),
    ];
    expect(withoutUsageLimitSubscriptions(plain)).toBe(plain);
    const [, untouched] = withoutUsageLimitSubscriptions([listed, plain[1]!]);
    expect(untouched).toBe(plain[1]);
  });
});

describe("remainingPercent", () => {
  it("inverts and clamps the reported usage", () => {
    expect(remainingPercent(window)).toBe(60);
    expect(remainingPercent({ ...window, usedPercent: 0 })).toBe(100);
    expect(remainingPercent({ ...window, usedPercent: 100 })).toBe(0);
    expect(remainingPercent({ ...window, usedPercent: 33.4 })).toBe(67);
  });
});

describe("isUsageLimitsCommand", () => {
  it("recognizes only the standalone local action", () => {
    expect(isUsageLimitsCommand("  /USAGE-LIMITS\n")).toBe(true);
    expect(isUsageLimitsCommand("/usage-limits explain")).toBe(false);
    expect(isUsageLimitsCommand("Explain /usage-limits")).toBe(false);
    expect(isUsageLimitsCommand("/usage")).toBe(false);
  });
});

describe("external usage settings", () => {
  it("deduplicates destinations across accounts and environments without inventing quota pools", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [managed, { ...managed, instanceId: ProviderInstanceId.make("personal") }],
          },
        },
      ],
      [
        EnvironmentId.make("b"),
        { entry: { target: { label: "B" } }, serverConfig: { providers: [managed] } },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([
      {
        ...managed.usageLimits!.externalUsage,
        message: "Track usage in ChatGPT.",
        accounts: [`${managed.instanceId} on A`, "personal on A", `${managed.instanceId} on B`],
      },
    ]);
    expect(collectLimitAccounts(presentations)).toEqual([]);
    expect(collectLimitNotices(presentations)).toEqual([]);
  });
  it("omits disabled, uninstalled and signed-out providers", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [
              { ...managed, enabled: false },
              { ...managed, installed: false },
              { ...managed, auth: { status: "unauthenticated" as const } },
              provider({}),
            ],
          },
        },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([]);
  });
});

describe("ChatGPT sharing presentation", () => {
  it("requires verified sharing metadata rather than the Codex driver or login type", () => {
    const codex = provider({ auth: { status: "authenticated", type: "chatgpt" } });
    expect(usesChatGptSharing(codex)).toBe(false);
    expect(
      usesChatGptSharing({ ...codex, auth: { ...codex.auth, subscriptionSharing: true } }),
    ).toBe(true);
    expect(
      usesChatGptSharing({
        ...codex,
        auth: { status: "unauthenticated", subscriptionSharing: true },
      }),
    ).toBe(false);
  });
});
