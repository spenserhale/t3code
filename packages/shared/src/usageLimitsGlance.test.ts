import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { NO_LIMIT_GROUPS } from "./usageLimitGroups.ts";
import { type LimitAccount } from "./usageLimits.ts";
import { collectLimitGlance, formatCheckedAgo } from "./usageLimitsGlance.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const checkedAt = "2026-09-03T11:57:00.000Z";
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const cursor = ProviderDriverKind.make("cursor");

type Window = LimitAccount["limits"]["windows"][number];

const session = (usedPercent: number): Window => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T13:05:00.000Z",
});

const weekly = (usedPercent: number): Window => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  windowDurationMins: 10_080,
  resetsAt: "2026-09-10T04:00:00.000Z",
});

function account(
  overrides: Partial<Omit<LimitAccount, "limits">> & Pick<LimitAccount, "key">,
  windows: readonly Window[] = [session(40)],
  checked = checkedAt,
): LimitAccount {
  return {
    driver: codex,
    displayName: null,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: checked, windows },
    ...overrides,
  };
}

const NAMES: Record<string, string> = { codex: "Codex", claudeAgent: "Claude", cursor: "Cursor" };
const nameOf = (entry: LimitAccount) => entry.displayName ?? NAMES[entry.driver] ?? entry.driver;

const glance = (accounts: readonly LimitAccount[], groups = NO_LIMIT_GROUPS) =>
  collectLimitGlance(accounts, groups, now, nameOf);

const rows = (accounts: readonly LimitAccount[]) =>
  glance(accounts).sections.flatMap((section) => section.rows);

describe("collectLimitGlance", () => {
  it("shows the window an account has least of left", () => {
    expect(rows([account({ key: "a" }, [session(50), weekly(16)])])).toMatchObject([
      { name: "Codex", windowLabel: "Session", remainingPercent: 50, resetsIn: "resets in 1h 5m" },
    ]);
    expect(rows([account({ key: "a" }, [session(10), weekly(45)])])).toMatchObject([
      { windowLabel: "Weekly", remainingPercent: 55, resetsIn: "resets in 6d 16h" },
    ]);
  });

  it("gives windows with the same share left to the shorter one", () => {
    expect(rows([account({ key: "a" }, [weekly(30), session(30)])])).toMatchObject([
      { windowLabel: "Session", remainingPercent: 70 },
    ]);
    // 29.6% and 30.4% used both read as 70% left.
    expect(rows([account({ key: "a" }, [weekly(30.4), session(29.6)])])).toMatchObject([
      { windowLabel: "Session", remainingPercent: 70 },
    ]);
  });

  it("leaves out Cursor's combined figure when both of its allowances are known", () => {
    const monthly = (id: string, label: string, usedPercent: number): Window => ({
      id,
      kind: "monthly",
      label,
      usedPercent,
    });
    const total = monthly("totalPercentUsed", "Total", 90);
    const auto = monthly("autoPercentUsed", "Auto", 10);
    const api = monthly("apiPercentUsed", "API", 30);

    expect(rows([account({ key: "a", driver: cursor }, [total, auto, api])])).toMatchObject([
      { name: "Cursor", windowLabel: "Other Models", remainingPercent: 70 },
    ]);
    expect(rows([account({ key: "a", driver: cursor }, [total, auto])])).toMatchObject([
      { windowLabel: "Overall", remainingPercent: 10 },
    ]);
  });

  it("decides Cursor's hidden figure over the whole section, as the page does", () => {
    const monthly = (id: string, label: string, usedPercent: number): Window => ({
      id,
      kind: "monthly",
      label,
      usedPercent,
    });
    const total = monthly("totalPercentUsed", "Total", 90);
    const auto = monthly("autoPercentUsed", "Auto", 10);
    const api = monthly("apiPercentUsed", "API", 30);

    // Between them the two accounts report both allowances, so the page hides
    // Overall for both, though the first has no API figure of its own.
    expect(
      rows([
        account({ key: "a", driver: cursor, email: "a@example.com" }, [total, auto]),
        account({ key: "b", driver: cursor, email: "b@example.com" }, [total, api]),
      ]).map((row) => [row.account.key, row.windowLabel, row.remainingPercent]),
    ).toEqual([
      ["a", "Cursor Models", 90],
      ["b", "Other Models", 70],
    ]);
    // Alone, the first reports only Auto and Overall, so Overall stays.
    expect(
      rows([account({ key: "a", driver: cursor, email: "a@example.com" }, [total, auto])]),
    ).toMatchObject([{ windowLabel: "Overall", remainingPercent: 10 }]);
    // Groups pool separately, so the second account's allowance does not hide Overall in the first's.
    const grouped = glance(
      [
        account({ key: "a", driver: cursor, email: "a@example.com" }, [total, auto]),
        account({ key: "b", driver: cursor, email: "b@example.com" }, [total, api]),
      ],
      { enabled: true, assignments: {} },
    );
    expect(
      grouped.sections.map((entry) => entry.rows.map((row) => [row.account.key, row.windowLabel])),
    ).toEqual([[["a", "Overall"]], [["b", "Overall"]]]);
  });

  it("keeps a row for a Cursor account that reports only the hidden window", () => {
    const monthly = (id: string, label: string, usedPercent: number): Window => ({
      id,
      kind: "monthly",
      label,
      usedPercent,
    });
    const total = monthly("totalPercentUsed", "Total", 90);
    const auto = monthly("autoPercentUsed", "Auto", 10);
    const api = monthly("apiPercentUsed", "API", 30);

    // Between them the other two accounts report both allowances, so Overall is hidden.
    expect(
      rows([
        account({ key: "a", driver: cursor, email: "a@example.com" }, [auto]),
        account({ key: "b", driver: cursor, email: "b@example.com" }, [api]),
        account({ key: "c", driver: cursor, email: "c@example.com" }, [total]),
      ]).map((row) => [row.account.key, row.windowLabel, row.remainingPercent]),
    ).toEqual([
      ["a", "Cursor Models", 90],
      ["b", "Other Models", 70],
      ["c", "Overall", 10],
    ]);
  });

  it("falls back to a Cursor account's hidden window once its shown ones have reset", () => {
    const monthly = (id: string, label: string, usedPercent: number, resetsAt: string): Window => ({
      id,
      kind: "monthly",
      label,
      usedPercent,
      resetsAt,
    });
    const past = "2026-09-03T11:00:00.000Z";
    const future = "2026-09-20T00:00:00.000Z";
    const api = monthly("apiPercentUsed", "API", 30, future);
    const accounts = (total: Window) => [
      account({ key: "a", driver: cursor, email: "a@example.com" }, [
        total,
        monthly("autoPercentUsed", "Auto", 10, past),
        monthly("apiPercentUsed", "API", 30, past),
      ]),
      account({ key: "b", driver: cursor, email: "b@example.com" }, [
        monthly("autoPercentUsed", "Auto", 10, future),
        api,
      ]),
    ];

    expect(
      rows(accounts(monthly("totalPercentUsed", "Total", 90, future))).map((row) => [
        row.account.key,
        row.resetSinceChecked,
        row.windowLabel,
        row.remainingPercent,
      ]),
    ).toEqual([
      ["a", false, "Overall", 10],
      ["b", false, "Other Models", 70],
    ]);
    // With Overall reset too, every window the account reports has reset.
    expect(
      rows(accounts(monthly("totalPercentUsed", "Total", 90, past))).map((row) => [
        row.account.key,
        row.resetSinceChecked,
      ]),
    ).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("passes over a window that has reset since it was read", () => {
    const expired = { ...session(80), resetsAt: "2026-09-03T11:00:00.000Z" };

    expect(rows([account({ key: "a" }, [expired, weekly(30)])])).toMatchObject([
      { windowLabel: "Weekly", remainingPercent: 70, resetSinceChecked: false },
    ]);
  });

  it("marks a row whose every window has reset, with no figure of its own", () => {
    const expired = { ...session(80), resetsAt: "2026-09-03T11:00:00.000Z" };
    const weeklyExpired = { ...weekly(30), resetsAt: "2026-09-03T11:59:59.999Z" };

    expect(rows([account({ key: "a" }, [expired, weeklyExpired])])).toEqual([
      expect.objectContaining({
        resetSinceChecked: true,
        windowLabel: null,
        remainingPercent: null,
        resetsIn: null,
      }),
    ]);
  });

  it("never treats a window without a reset time, or with an unreadable one, as reset", () => {
    const { resetsAt: _resetsAt, ...open } = session(25);
    const unreadable = { ...weekly(10), resetsAt: "soon" };

    expect(rows([account({ key: "a" }, [open])])).toMatchObject([
      { remainingPercent: 75, resetSinceChecked: false },
    ]);
    expect(rows([account({ key: "a" }, [unreadable])])).toMatchObject([
      { remainingPercent: 90, resetSinceChecked: false },
    ]);
  });

  it("keeps a window whose reset is this very moment", () => {
    const now0 = { ...session(20), resetsAt: "2026-09-03T12:00:00.000Z" };

    expect(rows([account({ key: "a" }, [now0])])).toMatchObject([
      { remainingPercent: 80, resetsIn: "resets now", resetSinceChecked: false },
    ]);
  });

  it("says nothing of a reset the window does not report", () => {
    const { resetsAt: _resetsAt, ...open } = session(25);

    expect(rows([account({ key: "a" }, [open])])).toMatchObject([
      { windowLabel: "Session", remainingPercent: 75, resetsIn: null },
    ]);
  });

  it("lists every account once, by provider, when groups are off", () => {
    const { sections } = glance([
      account({ key: "codex-work", email: "me@acme.dev" }),
      account({ key: "claude", driver: claude, email: "me@home.dev" }),
      account({ key: "codex-home", email: "me@home.dev" }),
    ]);

    expect(sections.map((section) => section.group)).toEqual([null]);
    expect(sections[0]?.rows.map((row) => [row.account.key, row.name])).toEqual([
      ["codex-work", "Codex 1"],
      ["codex-home", "Codex 2"],
      ["claude", "Claude"],
    ]);
  });

  it("puts accounts under their groups, named groups first, when groups are on", () => {
    const { sections } = glance(
      [
        account({ key: "codex-work", email: "me@acme.dev" }),
        account({ key: "claude-home", driver: claude, email: "me@home.dev" }),
        account({ key: "codex-home", email: "me@home.dev" }),
        account({ key: "claude-work", driver: claude, email: "ops@acme.dev" }),
        account({ key: "api-key" }),
      ],
      {
        enabled: true,
        assignments: { "codex:me@acme.dev": "Work", "claudeAgent:ops@acme.dev": "Work" },
      },
    );

    expect(
      sections.map((section) => [
        section.group?.kind,
        section.group?.name,
        section.rows.map((row) => [row.account.key, row.name]),
      ]),
    ).toEqual([
      [
        "named",
        "Work",
        [
          ["codex-work", "Codex"],
          ["claude-work", "Claude"],
        ],
      ],
      [
        "email",
        "me@home.dev",
        [
          ["claude-home", "Claude"],
          ["codex-home", "Codex"],
        ],
      ],
      ["other", "Other accounts", [["api-key", "Codex"]]],
    ]);
  });

  it("keeps an instance's own name and numbers only the names a section repeats", () => {
    const accounts = [
      account({ key: "b", email: "b@example.com" }),
      account({ key: "named", displayName: "Team", email: "team@example.com" }),
      account({ key: "a", email: "a@example.com" }),
    ];
    const grouped = glance(accounts, {
      enabled: true,
      assignments: { "codex:a@example.com": "Mine", "codex:team@example.com": "Mine" },
    });

    expect(rows(accounts).map((row) => [row.account.key, row.name])).toEqual([
      ["a", "Codex 1"],
      ["b", "Codex 2"],
      ["named", "Team"],
    ]);
    expect(
      grouped.sections.map((section) => section.rows.map((row) => [row.account.key, row.name])),
    ).toEqual([
      [
        ["a", "Codex"],
        ["named", "Team"],
      ],
      [["b", "Codex"]],
    ]);
  });

  it("reports the oldest read, whichever account it belongs to", () => {
    const stale = "2026-09-03T11:20:00.000Z";

    expect(
      glance([
        account({ key: "a", email: "a@example.com" }),
        account({ key: "b", driver: claude }, [session(40)], stale),
        account({ key: "c", email: "c@example.com" }, [session(40)], "2026-09-03T11:59:00.000Z"),
      ]).checkedAt,
    ).toBe(stale);
  });

  it("ignores a read it cannot date when finding the oldest", () => {
    expect(
      glance([
        account({ key: "a", email: "a@example.com" }, [session(40)], "not a date"),
        account({ key: "b", driver: claude }, [session(40)], "2026-09-03T11:30:00.000Z"),
        account({ key: "c", email: "c@example.com" }, [session(40)], ""),
      ]).checkedAt,
    ).toBe("2026-09-03T11:30:00.000Z");
    expect(glance([account({ key: "a" }, [session(40)], "not a date")]).checkedAt).toBeNull();
  });

  it("has nothing to show without accounts", () => {
    const empty = { sections: [], checkedAt: null };

    expect(glance([])).toEqual(empty);
    expect(glance([], { enabled: true, assignments: { "codex:a@example.com": "Mine" } })).toEqual(
      empty,
    );
  });
});

describe("formatCheckedAgo", () => {
  it("counts from the read to the moment given", () => {
    expect(formatCheckedAgo(checkedAt, now)).toBe("checked 3m ago");
    expect(formatCheckedAgo("2026-09-03T10:55:00.000Z", now)).toBe("checked 1h 5m ago");
  });

  it("says nothing of a read that is not a date", () => {
    expect(formatCheckedAgo("not a date", now)).toBeNull();
    expect(formatCheckedAgo("", now)).toBeNull();
  });

  it("calls a read from the last minute, or from a clock ahead of this one, just now", () => {
    expect(formatCheckedAgo("2026-09-03T11:59:01.000Z", now)).toBe("checked just now");
    expect(formatCheckedAgo("2026-09-03T12:00:30.000Z", now)).toBe("checked just now");
  });
});
