import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type LimitAccount, collectLimitAccounts, collectLimitPools } from "./usageLimits.ts";

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
