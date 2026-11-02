// @effect-diagnostics globalDate:off -- Fixtures are built from fixed instants.
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type LimitGroupState, NO_LIMIT_GROUPS } from "./usageLimitGroups.ts";
import { type LimitHistory, NO_LIMIT_HISTORY, limitSeriesKey } from "./usageLimitHistory.ts";
import {
  DEFAULT_REMINDER_SETTINGS,
  NO_REMINDER_STATE,
  REMINDER_TITLE,
  type ReminderSettings,
  markReminded,
  normalizeReminderSettings,
  planReminders,
  pruneReminderState,
  reminderBody,
  useItOrLoseIt,
} from "./usageLimitReminders.ts";
import { WORK_HOURS, type LimitSchedule } from "./usageLimitSchedule.ts";
import type { LimitAccount } from "./usageLimits.ts";

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Thursday 5 November, ten in the morning.
const now = at("2026-11-05T10:00:00Z");
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

type Window = LimitAccount["limits"]["windows"][number];

const weekly = (usedPercent: number, hoursLeft: number, id = "seven_day"): Window => ({
  id,
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: new Date(now + hoursLeft * HOUR).toISOString(),
});

const session = (usedPercent: number, minutesLeft: number): Window => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  windowDurationMins: 300,
  resetsAt: new Date(now + minutesLeft * 60_000).toISOString(),
});

const monthly = (usedPercent: number, hoursLeft: number): Window => ({
  id: "monthly",
  kind: "monthly",
  label: "Monthly",
  usedPercent,
  windowDurationMins: 30 * 24 * 60,
  resetsAt: new Date(now + hoursLeft * HOUR).toISOString(),
});

function account(
  key: string,
  windows: readonly Window[],
  overrides: Partial<LimitAccount> = {},
): LimitAccount {
  return {
    key,
    driver: claude,
    displayName: null,
    email: `${key}@example.com`,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: new Date(now - 60_000).toISOString(), windows },
    ...overrides,
  };
}

const unpaced = (window: Window): Window => {
  const { windowDurationMins: _length, ...rest } = window;
  return rest;
};

const nameOf = (entry: LimitAccount) => (entry.driver === codex ? "Codex" : "Claude");

const find = (
  accounts: readonly LimitAccount[],
  options: {
    groups?: LimitGroupState;
    settings?: Partial<ReminderSettings>;
    history?: LimitHistory;
    at?: number;
  } = {},
) =>
  useItOrLoseIt({
    accounts,
    groups: options.groups ?? NO_LIMIT_GROUPS,
    settings: { ...DEFAULT_REMINDER_SETTINGS, ...options.settings },
    history: options.history ?? NO_LIMIT_HISTORY,
    now: options.at ?? now,
  });

const names = (items: ReturnType<typeof find>) => items.map((item) => item.account.key);

describe("useItOrLoseIt", () => {
  it("picks a weekly window with plenty left that resets within a day and is going unused", () => {
    // Six days in, 40% spent: on course for about 45%, so over half would be lost.
    const [item, ...rest] = find([account("a", [weekly(40, 20)])]);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ remainingPercent: 60, resetsAt: now + 20 * HOUR });
    expect(item!.forecastUnusedPercent).toBeCloseTo(100 - 40 / ((168 - 20) / 168));
  });

  it("waits until the reset is within a day, and until enough is left", () => {
    expect(find([account("a", [weekly(40, 30)])])).toEqual([]);
    expect(find([account("a", [weekly(40, 24)])])).toHaveLength(1);
    // With no pace to judge by, the share left alone decides.
    expect(find([account("a", [unpaced(weekly(75, 20))])])).toHaveLength(1);
    expect(find([account("a", [unpaced(weekly(76, 20))])])).toEqual([]);
    const forty = { settings: { thresholdPercent: 40 } };
    expect(find([account("a", [unpaced(weekly(60, 20))])], forty)).toHaveLength(1);
    expect(find([account("a", [unpaced(weekly(61, 20))])], forty)).toHaveLength(0);
  });

  it("stays quiet when the pace so far would use it all anyway", () => {
    // 30% is left, but at this rate only about 16% of the week goes unused.
    expect(find([account("a", [weekly(70, 20)])])).toEqual([]);
    // With no pace to judge by, the share left is all there is to go on.
    const [item] = find([account("a", [unpaced(weekly(70, 20))])]);
    expect(item).toMatchObject({ remainingPercent: 30, forecastUnusedPercent: null });
  });

  it("gives monthly windows three days and sessions an hour, when sessions are asked for", () => {
    expect(find([account("a", [monthly(30, 60)])])).toHaveLength(1);
    expect(find([account("a", [monthly(30, 80)])])).toEqual([]);
    expect(find([account("a", [session(20, 40)])])).toEqual([]);
    const asked = { settings: { includeSession: true } };
    expect(find([account("a", [session(20, 40)])], asked)).toHaveLength(1);
    expect(find([account("a", [session(20, 90)])], asked)).toEqual([]);
  });

  it("needs the forecast to leave the threshold unused as well as the share left", () => {
    // 60% is left and about 54.6% would go unused.
    const a = account("a", [weekly(40, 20)]);
    expect(find([a], { settings: { thresholdPercent: 54 } })).toHaveLength(1);
    expect(find([a], { settings: { thresholdPercent: 55 } })).toEqual([]);
  });

  it("never picks a spent window, an unreadable reset, a reset already past, or another kind of window", () => {
    expect(find([account("a", [weekly(100, 10)])])).toEqual([]);
    const { resetsAt: _resetsAt, ...undated } = weekly(10, 10);
    expect(find([account("a", [undated])])).toEqual([]);
    expect(find([account("a", [weekly(10, -1)])])).toEqual([]);
    expect(find([account("a", [{ ...weekly(10, 10), kind: "other" }])])).toEqual([]);
  });

  it("skips a window that a longer, spent one blocks until after it resets", () => {
    const asked = { settings: { includeSession: true } };
    expect(find([account("a", [session(20, 40), weekly(100, 100)])], asked)).toEqual([]);
    // The week resets before the session does, so the session is usable again by then.
    expect(find([account("a", [session(20, 40), weekly(100, 0.5)])], asked)).toHaveLength(1);
    // A spent shorter window does not block a longer one, nor does another weekly.
    expect(find([account("a", [weekly(40, 20), session(100, 120)])])).toHaveLength(1);
    expect(find([account("a", [weekly(40, 20), weekly(100, 20, "opus")])])).toHaveLength(1);
  });

  it("counts the lead in the schedule's counted time, and only while the schedule is in session", () => {
    const work = account("w", [weekly(40, 55)]); // Resets Saturday 17:00 UTC.
    const groups: LimitGroupState = {
      enabled: false,
      assignments: { "claudeAgent:w@example.com": "Work" },
      schedules: { "named:Work": { ...WORK_HOURS, timeZone: "UTC" } },
    };
    // Thursday 10:00: seven hours of Thursday and eight of Friday are left, more than a counted day.
    expect(find([work], { groups })).toEqual([]);
    // Friday 10:00: only seven counted hours remain, inside the eight of a counted day.
    const friday = { groups, at: now + DAY };
    expect(find([account("w", [weekly(40, 31)])], friday)).toHaveLength(1);
    // After hours, and on the weekend, nothing is suggested.
    expect(find([account("w", [weekly(40, 20)])], { groups, at: now + 8 * HOUR })).toEqual([]);
    expect(find([account("w", [weekly(40, 20)])], { groups, at: now + 2 * DAY })).toEqual([]);
  });

  it("suggests a work account only while its schedule is in session, a personal one any day", () => {
    const groups: LimitGroupState = {
      enabled: true,
      assignments: { "claudeAgent:w@example.com": "Work" },
      schedules: { "named:Work": { days: [1, 2, 3, 4, 5], timeZone: "UTC" } },
    };
    const accounts = [
      account("w", [weekly(40, 20)]),
      account("p", [weekly(40, 20)], { driver: codex }),
    ];
    expect(names(find(accounts, { groups }))).toEqual(["w", "p"]);
    // Both reset early on Sunday, and it is Saturday morning.
    const sunday = { ...weekly(40, 0), resetsAt: "2026-11-08T06:00:00.000Z" };
    const weekend = [account("w", [sunday]), account("p", [sunday], { driver: codex })];
    const saturday = at("2026-11-07T10:00:00Z");
    expect(names(find(weekend, { groups, at: saturday }))).toEqual(["p"]);
    expect(names(find(weekend, { at: saturday }))).toEqual(["w", "p"]);
  });

  it("lists the soonest reset first, and the one with more left when resets coincide", () => {
    const accounts = [
      account("late", [weekly(40, 20)]),
      account("soon", [weekly(40, 5)]),
      account("same", [weekly(30, 20)]),
    ];
    expect(names(find(accounts))).toEqual(["soon", "same", "late"]);
  });

  it("follows the estimate chosen", () => {
    // Spending has slowed to a trickle, so the trend leaves more unused than the run rate does.
    const a = account("a", [weekly(40, 20)]);
    const recorded: LimitHistory = {
      [limitSeriesKey(a, weekly(0, 0))]: [
        {
          resetsAt: now + 20 * HOUR,
          from: now - 6 * DAY,
          readings: [
            [now - 6 * DAY, 0],
            [now - 2 * DAY, 1],
            [now - DAY, 2],
            [now - 2 * HOUR, 3],
          ],
        },
      ],
    };
    const unused = (settings: Partial<ReminderSettings>) =>
      find([a], { settings, history: recorded })[0]!.forecastUnusedPercent;
    expect(unused({})).toBeCloseTo(54.6, 0);
    expect(unused({ algorithm: "trend" })).toBeGreaterThan(59);
  });

  it("names a window by when it began while it is on record, else by its reset", () => {
    const a = account("a", [weekly(40, 20)]);
    const series = limitSeriesKey(a, weekly(0, 0));
    const recorded = {
      [series]: [
        {
          resetsAt: now + 20 * HOUR + 4_000,
          from: now - 6 * DAY,
          readings: [[now - 6 * DAY, 0] as const],
        },
      ],
    };
    expect(find([a], { history: recorded })[0]!.tag).toBe(`${series}|${now - 6 * DAY}`);
    expect(find([a])[0]!.tag).toBe(`${series}|${Math.round((now + 20 * HOUR) / 600_000)}`);
  });
});

describe("normalizeReminderSettings", () => {
  it("keeps what is valid and defaults the rest, field by field", () => {
    expect(normalizeReminderSettings(undefined)).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(
      normalizeReminderSettings({
        mode: "digest",
        thresholdPercent: 150.4,
        includeSession: "yes",
        algorithm: "trend",
      }),
    ).toEqual({ mode: "digest", thresholdPercent: 95, includeSession: false, algorithm: "trend" });
    expect(
      normalizeReminderSettings({
        mode: "loud",
        thresholdPercent: 1,
        includeSession: true,
        algorithm: "magic",
      }),
    ).toEqual({
      mode: "perWindow",
      thresholdPercent: 5,
      includeSession: true,
      algorithm: "runRate",
    });
    expect(normalizeReminderSettings({ thresholdPercent: Number.NaN }).thresholdPercent).toBe(25);
  });
});

describe("planReminders", () => {
  const work: LimitSchedule = { days: [1, 2, 3, 4, 5], timeZone: "UTC" };
  const groups: LimitGroupState = {
    enabled: true,
    assignments: { "claudeAgent:w@example.com": "Work", "codex:p@example.com": "Home" },
    schedules: { "named:Work": work },
  };
  const accounts = [
    account("w", [weekly(40, 20)]),
    account("p", [weekly(40, 8)], { driver: codex }),
    account("q", [weekly(40, 3)], { driver: codex, email: "q@example.com" }),
  ];
  const items = find(accounts, { groups });

  it("batches every qualifying window into one reminder, soonest reset first", () => {
    expect(items.map((item) => item.account.key)).toEqual(["q", "p", "w"]);
    const batches = planReminders(items, NO_REMINDER_STATE, "perWindow", now);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({ items, digest: null });
  });

  it("mentions a window once per reset, and a later one that qualifies on its own", () => {
    const [first] = planReminders(items, NO_REMINDER_STATE, "perWindow", now);
    const told = markReminded(NO_REMINDER_STATE, first!);
    expect(planReminders(items, told, "perWindow", now)).toEqual([]);
    const later = find(
      [...accounts, account("n", [weekly(40, 2)], { driver: codex, email: "n@example.com" })],
      { groups },
    );
    const [next] = planReminders(later, told, "perWindow", now);
    expect(next!.items.map((item) => item.account.key)).toEqual(["n"]);
    // The next week's window has its own reset, so its own tag.
    const nextWeek = find([account("w", [weekly(40, 20 + 168)])], { groups, at: now + 7 * DAY });
    expect(planReminders(nextWeek, told, "perWindow", now + 7 * DAY)).toHaveLength(1);
  });

  it("sends one digest a day for each group, at the first look that has something to say", () => {
    const batches = planReminders(items, NO_REMINDER_STATE, "digest", now);
    expect(
      batches.map((batch) => [batch.digest?.groupKey, batch.items.map((item) => item.account.key)]),
    ).toEqual([
      ["email:q@example.com", ["q"]],
      ["named:Home", ["p"]],
      ["named:Work", ["w"]],
    ]);
    const home = batches.find((batch) => batch.digest?.groupKey === "named:Home")!;
    const told = markReminded(NO_REMINDER_STATE, home);
    expect(told.digestDay["named:Home"]).toBe("2026-11-05");
    const again = planReminders(items, told, "digest", now + HOUR);
    expect(again.some((batch) => batch.digest?.groupKey === "named:Home")).toBe(false);
    expect(again).toHaveLength(2);
    // The window in the digest is not repeated tomorrow either.
    expect(
      planReminders(items, told, "digest", now + DAY).some(
        (batch) => batch.digest?.groupKey === "named:Home",
      ),
    ).toBe(false);
  });

  it("keeps a group's digest to its own day in its own zone", () => {
    const zoned = (timeZone: string): LimitGroupState => ({
      ...groups,
      schedules: { "named:Work": { days: [1, 2, 3, 4, 5], timeZone } },
    });
    // Noon UTC on Thursday is already one in the morning on Friday in Auckland.
    const noon = now + 2 * HOUR;
    const digestDay = (timeZone: string) =>
      planReminders(
        find([accounts[0]!], { groups: zoned(timeZone), at: noon }),
        NO_REMINDER_STATE,
        "digest",
        noon,
      )[0]?.digest?.day;
    expect(digestDay("Pacific/Auckland")).toBe("2026-11-06");
    expect(digestDay("UTC")).toBe("2026-11-05");
  });

  it.each(["inApp", "off"] as const)("says nothing in %s mode", (mode) => {
    expect(planReminders(items, NO_REMINDER_STATE, mode, now)).toEqual([]);
  });

  it("forgets windows a week after their reset and digests after a week", () => {
    const [batch] = planReminders(items, NO_REMINDER_STATE, "perWindow", now);
    const state = markReminded(markReminded(NO_REMINDER_STATE, batch!), {
      items: [],
      digest: { groupKey: "named:Work", day: "2026-11-05" },
    });
    expect(Object.keys(state.sent)).toHaveLength(3);
    expect(pruneReminderState(state, now)).toBe(state);
    // The first window to reset (q, in 3 hours) is the first to be forgotten.
    const afterFirst = pruneReminderState(state, now + 3 * HOUR + 7 * DAY + 1);
    expect(Object.keys(afterFirst.sent)).toHaveLength(2);
    expect(afterFirst.sent[batch!.items[0]!.tag]).toBeUndefined();
    expect(afterFirst.digestDay).toEqual({ "named:Work": "2026-11-05" });
    expect(pruneReminderState(state, now + 30 * DAY)).toEqual({ sent: {}, digestDay: {} });
  });
});

describe("reminderBody", () => {
  it("writes one line for each window and says what to do", () => {
    const groups: LimitGroupState = {
      enabled: false,
      assignments: { "claudeAgent:w@example.com": "Work" },
    };
    const items = find(
      [account("w", [weekly(40, 20)]), account("p", [weekly(30, 5)], { driver: codex })],
      { groups },
    );
    expect(REMINDER_TITLE).toBe("Use it or lose it");
    expect(reminderBody(items, now, nameOf)).toBe(
      [
        "Codex, Weekly: 70% left, resets in 5h 0m",
        "Claude (Work), Weekly: 60% left, resets in 20h 0m",
        "Switch to them today to use them before they reset.",
      ].join("\n"),
    );
    expect(reminderBody([items[0]!], now, nameOf)).toBe(
      "Codex, Weekly: 70% left, resets in 5h 0m\nSwitch to it today to use it before it resets.",
    );
  });

  it("never prints an email", () => {
    const items = find([account("w", [weekly(40, 20)])]);
    expect(reminderBody(items, now, nameOf)).not.toContain("@");
  });
});
