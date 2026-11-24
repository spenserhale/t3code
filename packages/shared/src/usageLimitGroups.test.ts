import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderUsageLimits,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_LIMIT_GROUPS,
  assignLimitGroup,
  carryOverLimitGroups,
  formerHubAccountKeys,
  groupLimitAccounts,
  labelLimitAccounts,
  limitAccountScheduleKey,
  limitGroupNames,
  limitGroupOf,
  MAX_LIMIT_GROUP_NAME_LENGTH,
  limitSubscriptionId,
  resolveLimitSchedule,
  setLimitGroupsEnabled,
  setLimitSchedule,
} from "./usageLimitGroups.ts";
import { EVERY_DAY, type LimitSchedule, WEEKDAYS, WORK_HOURS } from "./usageLimitSchedule.ts";
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
      const migrated = carryOverLimitGroups(legacy, accounts);
      expect(migrated.assignments).toMatchObject({ [business]: "Work", [plus]: "Work" });
      expect(migrated.schedules).toMatchObject({
        [limitAccountScheduleKey(business)]: WEEKDAYS,
        [limitAccountScheduleKey(plus)]: WEEKDAYS,
        "named:Work": WORK_HOURS,
      });
      expect(assignLimitGroup(migrated, plus, "Home").assignments[business]).toBe("Work");
    });

    it("stay for a workspace that is seen later, and are not brought back once it was given them", () => {
      const first = carryOverLimitGroups(legacy, [accounts[0]!]);
      expect(first.assignments[plus]).toBeUndefined();
      const later = carryOverLimitGroups(first, accounts);
      expect(later.assignments[plus]).toBe("Work");
      expect(resolveLimitSchedule(later, accounts[1]!)).toEqual(WEEKDAYS);
      // Taking a group and a schedule away from the first workspace is a choice that sticks.
      const cleared = setLimitSchedule(
        assignLimitGroup(later, business, ""),
        limitAccountScheduleKey(business),
        null,
      );
      const again = carryOverLimitGroups(cleared, accounts);
      expect(again).toBe(cleared);
      expect(again.assignments[business]).toBeUndefined();
      expect(again.schedules?.[limitAccountScheduleKey(business)]).toBeUndefined();
    });

    it("change nothing a second time, or where no account has changed identity", () => {
      const migrated = carryOverLimitGroups(legacy, accounts);
      expect(carryOverLimitGroups(migrated, accounts)).toBe(migrated);
      expect(carryOverLimitGroups(NO_LIMIT_GROUPS, accounts)).toBe(NO_LIMIT_GROUPS);
      const plain = [account({ key: "a", email: "me@acme.dev" })];
      expect(carryOverLimitGroups(legacy, plain)).toBe(legacy);
    });

    it("keep a key that is another account's own identity, and never overwrite a choice already made", () => {
      const kept = { ...accounts[0]!, identity: "codex:same@example.com" };
      const state = carryOverLimitGroups(legacy, [kept, accounts[1]!]);
      expect(state.assignments["codex:same@example.com"]).toBe("Work");
      expect(state.assignments[plus]).toBe("Work");
      const chosen = { ...legacy, assignments: { ...legacy.assignments, [business]: "Home" } };
      expect(carryOverLimitGroups(chosen, accounts).assignments[business]).toBe("Home");
    });
  });
});

describe("groups saved under an id an account had before", () => {
  const opencode = ProviderDriverKind.make("opencode");
  const laptop = EnvironmentId.make("laptop");
  const desktop = EnvironmentId.make("desktop");
  const seat = (id: string, workspaceId?: string) => ({
    id,
    driver: claude,
    ...(workspaceId ? { workspaceId } : {}),
    usageLimits: { checkedAt, windows: [session(40)] },
  });
  const hub = (id: string, endpoint: string, accounts: ReadonlyArray<ReturnType<typeof seat>>) => ({
    id: UsageLimitSourceId.make(id),
    kind: "cliproxy" as const,
    label: id,
    origin: new URL(endpoint).origin,
    endpoint,
    checkedAt,
    accounts,
  });
  const native = (usageLimits: ServerProviderUsageLimits, email?: string) => ({
    instanceId: ProviderInstanceId.make(email ? "codex" : "opencode"),
    driver: email ? codex : opencode,
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const, ...(email ? { email } : {}) },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  });
  type Environment = {
    readonly providers?: ReadonlyArray<ReturnType<typeof native>>;
    readonly sources?: ReadonlyArray<ReturnType<typeof hub>>;
  };
  const presentations = (environments: ReadonlyArray<readonly [EnvironmentId, Environment]>) =>
    new Map(
      environments.map(([id, { providers = [], sources = [] }]) => [
        id,
        {
          entry: { target: { label: id } },
          serverConfig: { providers, usageLimitSources: sources },
        },
      ]),
    ) satisfies LimitPresentations;
  const carry = (state: Parameters<typeof carryOverLimitGroups>[0], input: LimitPresentations) => {
    const accounts = collectLimitAccounts(input);
    return { accounts, state: carryOverLimitGroups(state, accounts, formerHubAccountKeys(input)) };
  };
  const named = (
    state: Parameters<typeof carryOverLimitGroups>[0],
    accounts: readonly LimitAccount[],
  ) => summary(groupLimitAccounts(accounts, state.assignments));

  // A local hub on the laptop, and a remote hub both machines read.
  const hubs = presentations([
    [
      laptop,
      {
        sources: [
          hub("hub", "http://127.0.0.1:8317", [seat("seat.json")]),
          hub("team", "https://hub.example.com/team-a", [seat("team.json", "ws-9")]),
        ],
      },
    ],
    [
      desktop,
      { sources: [hub("team", "https://hub.example.com/team-a", [seat("team.json", "ws-9")])] },
    ],
  ]);
  const local = "laptop:hub:seat.json";
  const remote = "https://hub.example.com/team-a:team.json:ws-9";

  it("finds what a hub account was given before its key named its hub, and keeps the old entry", () => {
    const saved = {
      enabled: true,
      assignments: { "hub:seat.json": "Work", "team:team.json:ws-9": "Personal" },
      schedules: {
        [limitAccountScheduleKey("team:team.json:ws-9")]: WEEKDAYS,
        "named:Work": WORK_HOURS,
      },
    };
    const { accounts, state } = carry(saved, hubs);

    expect(accounts.map(limitSubscriptionId)).toEqual([local, remote]);
    expect(state.assignments).toEqual({
      ...saved.assignments,
      [local]: "Work",
      [remote]: "Personal",
    });
    expect(state.migrated).toEqual([local, remote]);
    expect(named(state, accounts)).toEqual([
      ["named", "Personal", [remote]],
      ["named", "Work", [local]],
    ]);
    expect(accounts.map((entry) => resolveLimitSchedule(state, entry))).toEqual([
      WORK_HOURS,
      WEEKDAYS,
    ]);
    expect(state.schedules?.[limitAccountScheduleKey("team:team.json:ws-9")]).toEqual(WEEKDAYS);
  });

  it("finds what an account was given before its server named its credential", () => {
    const before = presentations([
      [laptop, { providers: [native({ checkedAt, windows: [session(40)] })] }],
    ]);
    expect(collectLimitAccounts(before).map(limitSubscriptionId)).toEqual(["laptop:opencode"]);
    const workspace = {
      checkedAt,
      windows: [session(40)],
      credentialFingerprint: "opencode-workspace:wrk",
    };
    const { accounts, state } = carry(
      { enabled: true, assignments: { "laptop:opencode": "Personal" } },
      presentations([[laptop, { providers: [native(workspace)] }]]),
    );

    expect(accounts.map(limitSubscriptionId)).toEqual([
      "opencode:credential:opencode-workspace:wrk",
    ]);
    expect(named(state, accounts)).toEqual([["named", "Personal", ["laptop:opencode"]]]);
  });

  it("never gives an account a group saved for another, and keeps what matches nothing", () => {
    // The laptop's OpenCode split into one account per subscription, each with its own key; none
    // of them is the account that was saved under the machine's key, so none takes its group.
    const subscription = (credentialFingerprint: string) =>
      account({
        key: `laptop:opencode:${credentialFingerprint}`,
        driver: opencode,
        environments: [{ environmentId: laptop, label: "laptop" }],
        limits: { checkedAt, windows: [session(40)], credentialFingerprint },
      });
    const accounts = [
      subscription("opencode-workspace:wrk"),
      subscription("a1".repeat(32)),
      subscription("b2".repeat(32)),
      // An email names its account in every build, so its key never stood for it.
      account({ key: "laptop:codex", email: "me@acme.dev" }),
    ];
    const saved = {
      enabled: true,
      assignments: {
        "laptop:opencode": "Personal",
        [`opencode:credential:${"c3".repeat(32)}`]: "Personal",
        [`opencode:credential:${"b2".repeat(32)}`]: "Work",
        "laptop:codex": "Work",
        "gone:hub:seat.json": "Work",
      },
    };

    expect(carryOverLimitGroups(saved, accounts)).toBe(saved);
    expect(named(saved, accounts)).toEqual([
      ["named", "Work", [`laptop:opencode:${"b2".repeat(32)}`]],
      ["email", "me@acme.dev", ["laptop:codex"]],
      [
        "other",
        "Other accounts",
        ["laptop:opencode:opencode-workspace:wrk", `laptop:opencode:${"a1".repeat(32)}`],
      ],
    ]);
  });

  it("carries once: a group taken away stays away, and a second pass changes nothing", () => {
    const saved = { enabled: true, assignments: { "hub:seat.json": "Work" } };
    const { accounts, state } = carry(saved, hubs);
    expect(carryOverLimitGroups(state, accounts, formerHubAccountKeys(hubs))).toBe(state);

    const cleared = assignLimitGroup(state, local, "");
    expect(cleared.assignments[local]).toBeUndefined();
    expect(carryOverLimitGroups(cleared, accounts, formerHubAccountKeys(hubs))).toBe(cleared);
    expect(carryOverLimitGroups(NO_LIMIT_GROUPS, accounts, formerHubAccountKeys(hubs))).toBe(
      NO_LIMIT_GROUPS,
    );
  });

  it("gives nothing when former ids disagree, and never overwrites an account's own group", () => {
    // Two machines named the same remote hub differently, and the two names were given different groups.
    const renamed = presentations([
      [
        laptop,
        { sources: [hub("team", "https://hub.example.com/team-a", [seat("team.json", "ws-9")])] },
      ],
      [
        desktop,
        { sources: [hub("shared", "https://hub.example.com/team-a", [seat("team.json", "ws-9")])] },
      ],
    ]);
    const disagree = carry(
      {
        enabled: true,
        assignments: { "team:team.json:ws-9": "Work", "shared:team.json:ws-9": "Personal" },
      },
      renamed,
    );
    expect(disagree.state.assignments[remote]).toBeUndefined();
    expect(disagree.state.migrated).toEqual([remote]);

    const agree = carry(
      {
        enabled: true,
        assignments: { "team:team.json:ws-9": "Work", "shared:team.json:ws-9": " Work " },
      },
      renamed,
    );
    expect(agree.state.assignments[remote]).toBe("Work");

    const own = carry(
      { enabled: true, assignments: { "team:team.json:ws-9": "Work", [remote]: "Home" } },
      renamed,
    );
    expect(own.state.assignments[remote]).toBe("Home");
    expect(own.state.migrated).toEqual([remote]);

    const berlin = { days: [1, 2, 3, 4, 5], timeZone: "Europe/Berlin" } as const;
    const scheduled = (first: LimitSchedule, second: LimitSchedule) =>
      carry(
        {
          enabled: true,
          assignments: {},
          schedules: {
            [limitAccountScheduleKey("team:team.json:ws-9")]: first,
            [limitAccountScheduleKey("shared:team.json:ws-9")]: second,
          },
        },
        renamed,
      ).state.schedules?.[limitAccountScheduleKey(remote)];
    expect(scheduled(berlin, { timeZone: "Europe/Berlin", days: [1, 2, 3, 4, 5] })).toEqual(berlin);
    expect(scheduled(WEEKDAYS, WORK_HOURS)).toBeUndefined();
  });

  it("keeps every group of a saved state like the real one, and gives a new workspace its login's", () => {
    const linkPro = EnvironmentId.make("6b1f37c2-0000-4000-8000-000000000001");
    const rw = EnvironmentId.make("1c0145ff-0000-4000-8000-000000000002");
    const zai = "a1".repeat(32);
    const ollama = "b2".repeat(32);
    const goKey = "c3".repeat(32);
    const google = "d4".repeat(32);
    const at = (environmentId: EnvironmentId) => [{ environmentId, label: environmentId }];
    const native = (driver: string, instance: string, identity: string, email?: string) =>
      account({
        key: `${linkPro}:${instance}`,
        identity,
        driver: ProviderDriverKind.make(driver),
        email,
        environments: at(linkPro),
      });
    // OpenCode reads one account per subscription, each under its own credential.
    const subscription = (environmentId: EnvironmentId, credentialFingerprint: string) =>
      account({
        key: `${environmentId}:opencode:${credentialFingerprint}`,
        identity: `opencode:credential:${credentialFingerprint}`,
        driver: opencode,
        environments: at(environmentId),
        limits: { checkedAt, windows: [session(40)], credentialFingerprint },
      });
    const accounts = [
      native("codex", "codex", "codex:b@home.dev", "b@home.dev"),
      native("codex", "codex_personal", "codex:a@work.dev:ws-personal", "a@work.dev"),
      native("codex", "codex_team", "codex:a@work.dev:ws-team", "a@work.dev"),
      native("codex", "codex_new", "codex:a@work.dev:ws-new", "a@work.dev"),
      native("claudeAgent", "claude", "claudeAgent:c@home.dev", "c@home.dev"),
      native("claudeAgent", "claude_personal", "claudeAgent:d@work.dev:org-personal", "d@work.dev"),
      native("claudeAgent", "claude_team", "claudeAgent:d@work.dev:org-team", "d@work.dev"),
      subscription(rw, "opencode-workspace:wrk_home"),
      subscription(linkPro, zai),
      subscription(linkPro, ollama),
      native("antigravity", "antigravity", `antigravity:credential:${google}`),
      native("cursor", "cursor", "cursor:e@home.dev", "e@home.dev"),
    ];
    const saved = {
      enabled: true,
      assignments: {
        "codex:a@work.dev": "Work",
        "codex:b@home.dev": "Personal",
        "claudeAgent:c@home.dev": "Personal",
        "claudeAgent:d@work.dev": "Work",
        "codex:a@work.dev:ws-personal": "Personal",
        "codex:a@work.dev:ws-team": "Work",
        "claudeAgent:d@work.dev:org-personal": "Personal",
        "claudeAgent:d@work.dev:org-team": "Work",
        [`${rw}:opencode`]: "Personal",
        [`opencode:credential:${zai}`]: "Personal",
        [`opencode:credential:${goKey}`]: "Personal",
        [`antigravity:credential:${google}`]: "Personal",
        "cursor:e@home.dev": "Personal",
      },
      schedules: { "named:Work": WORK_HOURS },
      migrated: [
        "codex:a@work.dev:ws-personal",
        "codex:a@work.dev:ws-team",
        "claudeAgent:d@work.dev:org-personal",
        "claudeAgent:d@work.dev:org-team",
      ],
    };
    const state = carryOverLimitGroups(saved, accounts);

    expect(state).toEqual({
      ...saved,
      assignments: { ...saved.assignments, "codex:a@work.dev:ws-new": "Work" },
      migrated: [...saved.migrated, "codex:a@work.dev:ws-new"],
    });
    expect(carryOverLimitGroups(state, accounts)).toBe(state);
    // The OpenCode workspace was the machine's own account; nothing says which subscription
    // took its place, so it waits for a group, as Ollama Cloud does.
    expect(named(state, accounts)).toEqual([
      [
        "named",
        "Personal",
        [
          `${linkPro}:codex`,
          `${linkPro}:codex_personal`,
          `${linkPro}:claude`,
          `${linkPro}:claude_personal`,
          `${linkPro}:opencode:${zai}`,
          `${linkPro}:antigravity`,
          `${linkPro}:cursor`,
        ],
      ],
      [
        "named",
        "Work",
        [`${linkPro}:codex_team`, `${linkPro}:codex_new`, `${linkPro}:claude_team`],
      ],
      [
        "other",
        "Other accounts",
        [`${rw}:opencode:opencode-workspace:wrk_home`, `${linkPro}:opencode:${ollama}`],
      ],
    ]);
    expect(resolveLimitSchedule(state, accounts[3]!)).toEqual(WORK_HOURS);
  });
});
