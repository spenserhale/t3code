import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_LIMIT_GROUPS,
  assignLimitGroup,
  groupLimitAccounts,
  labelLimitAccounts,
  limitGroupNames,
  MAX_LIMIT_GROUP_NAME_LENGTH,
  limitSubscriptionId,
  setLimitGroupsEnabled,
} from "./usageLimitGroups.ts";
import {
  type LimitAccount,
  type LimitPresentations,
  collectLimitAccounts,
  collectLimitPools,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const checkedAt = "2026-09-03T11:00:00.000Z";
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

function session(usedPercent: number) {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    windowDurationMins: 300,
    resetsAt: "2026-09-03T14:00:00.000Z",
  } as const;
}

function account(overrides: Partial<LimitAccount> & Pick<LimitAccount, "key">): LimitAccount {
  return {
    driver: codex,
    displayName: null,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt, windows: [session(40)] },
    ...overrides,
  };
}

const summary = (groups: ReturnType<typeof groupLimitAccounts>) =>
  groups.map((group) => [group.kind, group.name, group.accounts.map((member) => member.key)]);

describe("limitSubscriptionId", () => {
  it("names a subscription by provider and email, whatever the email's case", () => {
    expect(limitSubscriptionId(account({ key: "a", email: " Me@Example.com " }))).toBe(
      "codex:me@example.com",
    );
    expect(
      limitSubscriptionId(account({ key: "a", driver: claude, email: "me@example.com" })),
    ).toBe("claudeAgent:me@example.com");
  });

  it("falls back to the credential, then to the account's own key", () => {
    const limits = { checkedAt, windows: [session(40)], credentialFingerprint: "abc" };
    expect(limitSubscriptionId(account({ key: "a", limits }))).toBe("codex:credential:abc");
    expect(limitSubscriptionId(account({ key: "a", email: "me@example.com", limits }))).toBe(
      "codex:me@example.com",
    );
    expect(limitSubscriptionId(account({ key: "laptop:codex", email: "  " }))).toBe("laptop:codex");
  });

  it("stays the same when another environment reports the account first", () => {
    const environment = (label: string) => ({
      entry: { target: { label } },
      serverConfig: {
        providers: [
          {
            instanceId: ProviderInstanceId.make(`codex-${label}`),
            driver: codex,
            enabled: true,
            installed: true,
            version: null,
            status: "ready" as const,
            auth: { status: "authenticated" as const, email: "me@example.com" },
            checkedAt,
            models: [],
            slashCommands: [],
            skills: [],
            usageLimits: { checkedAt, windows: [session(40)] },
          },
        ],
      },
    });
    const laptop = [EnvironmentId.make("laptop"), environment("laptop")] as const;
    const desktop = [EnvironmentId.make("desktop"), environment("desktop")] as const;
    const forward = collectLimitAccounts(new Map([laptop, desktop]) satisfies LimitPresentations);
    const reverse = collectLimitAccounts(new Map([desktop, laptop]) satisfies LimitPresentations);

    expect(forward.map((entry) => entry.key)).not.toEqual(reverse.map((entry) => entry.key));
    expect(forward.map(limitSubscriptionId)).toEqual(["codex:me@example.com"]);
    expect(reverse.map(limitSubscriptionId)).toEqual(["codex:me@example.com"]);
  });
});

describe("groupLimitAccounts", () => {
  const personalCodex = account({ key: "personal-codex", email: "me@home.dev" });
  const personalClaude = account({ key: "personal-claude", driver: claude, email: "Me@Home.dev" });
  const workCodex = account({ key: "work-codex", email: "me@acme.dev" });
  const workClaude = account({ key: "work-claude", driver: claude, email: "ops@acme.dev" });
  const apiKey = account({ key: "laptop:opencode", driver: ProviderDriverKind.make("opencode") });

  it("puts accounts of different providers under one email in the same group", () => {
    expect(summary(groupLimitAccounts([personalCodex, workCodex, personalClaude], {}))).toEqual([
      ["email", "me@acme.dev", ["work-codex"]],
      ["email", "me@home.dev", ["personal-codex", "personal-claude"]],
    ]);
  });

  it("lets an assignment beat the email and collects accounts with neither last", () => {
    const groups = groupLimitAccounts([apiKey, personalCodex, workCodex, workClaude], {
      "codex:me@acme.dev": "Work",
      "claudeAgent:ops@acme.dev": "Work",
    });

    expect(summary(groups)).toEqual([
      ["named", "Work", ["work-codex", "work-claude"]],
      ["email", "me@home.dev", ["personal-codex"]],
      ["other", "Other accounts", ["laptop:opencode"]],
    ]);
    expect(groups.map((group) => group.key)).toEqual(["named:Work", "email:me@home.dev", "other"]);
  });

  it("orders named groups before emails, each alphabetically without regard to case", () => {
    const groups = groupLimitAccounts([personalCodex, workCodex, workClaude, apiKey], {
      "codex:me@acme.dev": "work",
      "claudeAgent:ops@acme.dev": "Acme",
      "laptop:opencode": "personal",
    });

    expect(groups.map((group) => group.name)).toEqual(["Acme", "personal", "work", "me@home.dev"]);
  });

  it("leaves out groups whose accounts are not on show", () => {
    const assignments = { "codex:gone@acme.dev": "Work", "codex:me@home.dev": " " };

    expect(summary(groupLimitAccounts([personalCodex], assignments))).toEqual([
      ["email", "me@home.dev", ["personal-codex"]],
    ]);
    expect(groupLimitAccounts([], assignments)).toEqual([]);
  });

  it("pools each group from its own accounts only", () => {
    const spent = account({
      key: "work-codex",
      email: "me@acme.dev",
      limits: { checkedAt, windows: [session(90)] },
    });
    const fresh = account({
      key: "personal-codex",
      email: "me@home.dev",
      limits: { checkedAt, windows: [session(10)] },
    });
    const left = (accounts: readonly LimitAccount[]) =>
      collectLimitPools(accounts, now).map((pool) => pool.windows[0]?.remainingPercent);

    expect(left([spent, fresh])).toEqual([50]);
    expect(groupLimitAccounts([spent, fresh], {}).map((group) => left(group.accounts))).toEqual([
      [10],
      [90],
    ]);
  });
});

describe("labelLimitAccounts", () => {
  const nameOf = (entry: LimitAccount) => entry.displayName ?? "Codex";
  const windows = (resetsAt: string) => [{ ...session(40), resetsAt }];
  const soon = windows("2026-09-03T13:00:00.000Z");
  const later = windows("2026-09-03T18:00:00.000Z");
  const rows = (first: typeof soon, second: typeof soon) =>
    labelLimitAccounts(
      collectLimitPools(
        [
          account({ key: "a", email: "a@example.com", limits: { checkedAt, windows: first } }),
          account({ key: "b", email: "b@example.com", limits: { checkedAt, windows: second } }),
        ],
        now,
      ).map((pool) => pool.accounts),
      nameOf,
    ).map((row) => [row.account.key, row.label]);

  it("numbers accounts that share a name the same way whatever their reset times", () => {
    const expected = [
      ["a", "Codex 1"],
      ["b", "Codex 2"],
    ];
    expect(rows(soon, later)).toEqual(expected);
    expect(rows(later, soon)).toEqual(expected);
  });

  it("keeps providers in the order given and sorts by name within each", () => {
    const labelled = labelLimitAccounts(
      [
        [
          account({ key: "z", displayName: "Zed", email: "z@example.com" }),
          account({ key: "w", displayName: "Work", email: "w@example.com" }),
        ],
        [account({ key: "c", driver: claude, displayName: "Alpha", email: "c@example.com" })],
      ],
      (entry) => entry.displayName ?? "",
    );
    expect(labelled.map((row) => row.label)).toEqual(["Work", "Zed", "Alpha"]);
  });
});

describe("assigning groups", () => {
  it("turns the grouped view on when an account is given a group", () => {
    expect(assignLimitGroup(NO_LIMIT_GROUPS, "codex:me@acme.dev", "  Work ")).toEqual({
      enabled: true,
      assignments: { "codex:me@acme.dev": "Work" },
    });
  });

  it("cuts a name longer than the limit", () => {
    const long = `${"a".repeat(MAX_LIMIT_GROUP_NAME_LENGTH - 1)} ${"b".repeat(10)}`;

    expect(assignLimitGroup(NO_LIMIT_GROUPS, "a", long).assignments.a).toBe(
      "a".repeat(MAX_LIMIT_GROUP_NAME_LENGTH - 1),
    );
    expect(assignLimitGroup(NO_LIMIT_GROUPS, "a", "x".repeat(500)).assignments.a).toHaveLength(
      MAX_LIMIT_GROUP_NAME_LENGTH,
    );
  });

  it("clears an assignment with a blank name and leaves the view as it was", () => {
    const assigned = { enabled: true, assignments: { a: "Work", b: "Personal" } };

    expect(assignLimitGroup(assigned, "a", "   ")).toEqual({
      enabled: true,
      assignments: { b: "Personal" },
    });
    expect(assignLimitGroup(NO_LIMIT_GROUPS, "a", "")).toEqual(NO_LIMIT_GROUPS);
  });

  it("keeps assignments when the grouped view is switched off", () => {
    const assigned = assignLimitGroup(NO_LIMIT_GROUPS, "a", "Work");

    expect(setLimitGroupsEnabled(assigned, false)).toEqual({
      enabled: false,
      assignments: { a: "Work" },
    });
  });

  it("offers each group name once, including groups with no account on show", () => {
    expect(limitGroupNames({ a: "work", b: "Acme", c: "work", d: "Personal" })).toEqual([
      "Acme",
      "Personal",
      "work",
    ]);
  });
});
