import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_LIMIT_GROUPS,
  assignLimitGroup,
  groupLimitAccounts,
  labelLimitAccounts,
  limitAccountScheduleKey,
  limitGroupNames,
  limitGroupOf,
  MAX_LIMIT_GROUP_NAME_LENGTH,
  limitSubscriptionId,
  migrateLegacyAccountKeys,
  resolveLimitSchedule,
  setLimitGroupsEnabled,
  setLimitSchedule,
} from "./usageLimitGroups.ts";
import { EVERY_DAY, WEEKDAYS, WORK_HOURS } from "./usageLimitSchedule.ts";
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

describe("schedules", () => {
  const work = account({ key: "w", email: "me@acme.dev" });
  const home = account({ key: "h", driver: claude, email: "me@home.dev" });
  const assigned = { ...NO_LIMIT_GROUPS, assignments: { "codex:me@acme.dev": "Work" } };

  it("finds the group an account is in whether or not the grouped view is on", () => {
    expect(limitGroupOf(work, assigned.assignments)).toEqual({
      key: "named:Work",
      kind: "named",
      name: "Work",
    });
    expect(limitGroupOf(home, assigned.assignments)).toEqual({
      key: "email:me@home.dev",
      kind: "email",
      name: "me@home.dev",
    });
    expect(limitGroupOf(account({ key: "x" }), {})).toMatchObject({ key: "other", kind: "other" });
  });

  it("gives an account its own schedule, else its group's, else none", () => {
    const state = {
      ...assigned,
      schedules: {
        "named:Work": WORK_HOURS,
        [limitAccountScheduleKey("claudeAgent:me@home.dev")]: WEEKDAYS,
      },
    };
    expect(resolveLimitSchedule(state, work)).toEqual(WORK_HOURS);
    expect(resolveLimitSchedule(state, home)).toEqual(WEEKDAYS);
    expect(resolveLimitSchedule(state, account({ key: "x", email: "a@b.dev" }))).toBeUndefined();
    expect(resolveLimitSchedule(assigned, work)).toBeUndefined();
    // An account can be set back to every day while its group works weekdays.
    const own = setLimitSchedule(state, limitAccountScheduleKey("codex:me@acme.dev"), EVERY_DAY);
    expect(resolveLimitSchedule(own, work)).toEqual(EVERY_DAY);
  });

  it("applies with the grouped view off", () => {
    const state = setLimitSchedule(setLimitGroupsEnabled(assigned, false), "named:Work", WEEKDAYS);
    expect(state.enabled).toBe(false);
    expect(resolveLimitSchedule(state, work)).toEqual(WEEKDAYS);
  });

  it("sets and clears schedules without disturbing assignments, and leaves no empty record behind", () => {
    const set = setLimitSchedule(assigned, "named:Work", WEEKDAYS);
    expect(set).toEqual({ ...assigned, schedules: { "named:Work": WEEKDAYS } });
    expect(setLimitSchedule(set, "named:Work", null)).toEqual(assigned);
    expect("schedules" in setLimitSchedule(set, "named:Work", null)).toBe(false);
    expect(setLimitSchedule(NO_LIMIT_GROUPS, "other", null)).toEqual(NO_LIMIT_GROUPS);
  });

  it("keeps schedules when an account is given a group, or the group is cleared", () => {
    const state = setLimitSchedule(NO_LIMIT_GROUPS, "named:Work", WEEKDAYS);
    expect(assignLimitGroup(state, "codex:me@acme.dev", "Work").schedules).toEqual({
      "named:Work": WEEKDAYS,
    });
    expect(assignLimitGroup(assignLimitGroup(state, "a", "Work"), "a", "").schedules).toEqual({
      "named:Work": WEEKDAYS,
    });
  });
});

describe("one email in two workspaces", () => {
  const weekly = {
    id: "primary",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 8,
    windowDurationMins: 10_080,
    resetsAt: "2026-09-08T12:00:00.000Z",
  } as const;
  const login = (instanceId: string, workspaceId?: string) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: codex,
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: {
      status: "authenticated" as const,
      email: "same@example.com",
      ...(workspaceId ? { workspaceId } : {}),
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows: [weekly] },
  });
  const accountsOf = (...logins: Array<ReturnType<typeof login>>) =>
    collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("laptop"),
          { entry: { target: { label: "Laptop" } }, serverConfig: { providers: logins } },
        ],
      ]) satisfies LimitPresentations,
    );
  const business = "codex:same@example.com:ws-business";
  const plus = "codex:same@example.com:ws-plus";

  it("names each workspace's subscription apart, and the same wherever it is reported", () => {
    const accounts = accountsOf(login("business", "ws-business"), login("personal", "ws-plus"));
    expect(accounts.map(limitSubscriptionId)).toEqual([business, plus]);
    expect(
      accountsOf(login("personal", "ws-plus"), login("business", "ws-business"))
        .map(limitSubscriptionId)
        .sort(),
    ).toEqual([business, plus]);
    // A login the page cannot tell which workspace it is keeps to its own instance.
    const unplaced = accountsOf(
      login("business", "ws-business"),
      login("personal", "ws-plus"),
      login("other"),
    );
    expect(unplaced.map(limitSubscriptionId)).toEqual([business, plus, "laptop:other"]);
  });

  it("lets one workspace be in a group and keep its own schedule", () => {
    const accounts = accountsOf(login("business", "ws-business"), login("personal", "ws-plus"));
    const state = setLimitSchedule(
      assignLimitGroup(NO_LIMIT_GROUPS, business, "Work"),
      limitAccountScheduleKey(plus),
      WEEKDAYS,
    );
    expect(summary(groupLimitAccounts(accounts, state.assignments))).toEqual([
      ["named", "Work", ["laptop:business"]],
      ["email", "same@example.com", ["laptop:personal"]],
    ]);
    expect(accounts.map((entry) => resolveLimitSchedule(state, entry))).toEqual([
      undefined,
      WEEKDAYS,
    ]);
  });

  describe("assignments made before accounts carried a workspace", () => {
    const accounts = accountsOf(login("business", "ws-business"), login("personal", "ws-plus"));
    const legacy = {
      enabled: true,
      assignments: { "codex:same@example.com": "Work", "claudeAgent:other@example.com": "Home" },
      schedules: {
        [limitAccountScheduleKey("codex:same@example.com")]: WEEKDAYS,
        "named:Work": WORK_HOURS,
      },
    };

    it("pass to every workspace under that email, which can then be changed apart", () => {
      const migrated = migrateLegacyAccountKeys(legacy, accounts);
      expect(migrated.assignments).toEqual({
        [business]: "Work",
        [plus]: "Work",
        "claudeAgent:other@example.com": "Home",
      });
      expect(migrated.schedules).toEqual({
        [limitAccountScheduleKey(business)]: WEEKDAYS,
        [limitAccountScheduleKey(plus)]: WEEKDAYS,
        "named:Work": WORK_HOURS,
      });
      expect(assignLimitGroup(migrated, plus, "Home").assignments[business]).toBe("Work");
    });

    it("change nothing a second time, or where no account has changed identity", () => {
      const migrated = migrateLegacyAccountKeys(legacy, accounts);
      expect(migrateLegacyAccountKeys(migrated, accounts)).toBe(migrated);
      expect(migrateLegacyAccountKeys(NO_LIMIT_GROUPS, accounts)).toBe(NO_LIMIT_GROUPS);
      const plain = [account({ key: "a", email: "me@acme.dev" })];
      expect(migrateLegacyAccountKeys(legacy, plain)).toBe(legacy);
    });

    it("keep a key that is another account's own identity, and never overwrite a choice already made", () => {
      const kept = { ...accounts[0]!, identity: "codex:same@example.com" };
      const state = migrateLegacyAccountKeys(legacy, [kept, accounts[1]!]);
      expect(state.assignments["codex:same@example.com"]).toBe("Work");
      expect(state.assignments[plus]).toBe("Work");
      const chosen = { ...legacy, assignments: { ...legacy.assignments, [business]: "Home" } };
      expect(migrateLegacyAccountKeys(chosen, accounts).assignments[business]).toBe("Home");
    });
  });
});
