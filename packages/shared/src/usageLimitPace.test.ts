import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  paceLabel,
  paceOutlook,
  paceSummary,
  pooledPace,
  scheduledElapsedShare,
  scheduledPaceRemaining,
  windowPace,
  windowSpan,
} from "./usageLimitPace.ts";
import type { LimitReading } from "./usageLimitHistory.ts";
import type { LimitSchedule } from "./usageLimitSchedule.ts";
import { elapsedShare, paceOf } from "./usageLimits.ts";

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const weekdaysUtc: LimitSchedule = { days: [1, 2, 3, 4, 5], timeZone: "UTC" };

// A week from Monday to Monday.
const weekly = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: "2026-11-09T00:00:00.000Z",
});

describe("windowSpan", () => {
  it("is the reset and the length before it", () => {
    expect(windowSpan(weekly(0))).toEqual({
      start: at("2026-11-02T00:00:00Z"),
      end: at("2026-11-09T00:00:00Z"),
    });
  });

  it("takes a monthly window with no length for the calendar month before its reset", () => {
    const monthly = (resetsAt: string): ServerProviderUsageWindow => ({
      id: "totalPercentUsed",
      kind: "monthly",
      label: "Overall",
      usedPercent: 10,
      resetsAt,
    });
    expect(windowSpan(monthly("2026-11-15T12:30:00.000Z"))?.start).toBe(
      at("2026-10-15T12:30:00.000Z"),
    );
    expect(windowSpan(monthly("2026-03-31T00:00:00.000Z"))?.start).toBe(
      at("2026-02-28T00:00:00.000Z"),
    );
    expect(windowSpan(monthly("2026-01-15T00:00:00.000Z"))?.start).toBe(
      at("2025-12-15T00:00:00.000Z"),
    );
    expect(
      windowSpan({ ...monthly("2026-11-15T00:00:00.000Z"), windowDurationMins: 60 * 24 * 30 })
        ?.start,
    ).toBe(at("2026-10-16T00:00:00.000Z"));
  });

  it("has no span without a reset, or for a short window without a length", () => {
    const { resetsAt: _resetsAt, ...undated } = weekly(10);
    expect(windowSpan(undated)).toBeNull();
    const { windowDurationMins: _length, ...unsized } = weekly(10);
    expect(windowSpan(unsized)).toBeNull();
    expect(windowSpan({ ...weekly(10), resetsAt: "soon" })).toBeNull();
  });
});

describe("a window that counts every hour", () => {
  const session: ServerProviderUsageWindow = {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent: 40,
    windowDurationMins: 300,
    resetsAt: "2026-09-03T14:00:00.000Z",
  };
  const now = at("2026-09-03T12:00:00.000Z");

  it("reads the same elapsed share as the plain pace", () => {
    expect(scheduledElapsedShare(session, now)).toBeCloseTo(elapsedShare(session, now)!);
    expect(scheduledElapsedShare(session, now, { days: [1, 2, 3, 4, 5, 6, 7] })).toBeCloseTo(0.6);
  });

  it("agrees with the plain pace outside its two-point band", () => {
    for (const used of [10, 30, 80, 95]) {
      const window = { ...session, usedPercent: used };
      expect(windowPace(window, now)?.state).toBe(paceOf(window, now));
    }
  });

  it("calls spending within two points of even spending on pace", () => {
    expect(windowPace({ ...session, usedPercent: 61 }, now)?.state).toBe("on");
    expect(windowPace({ ...session, usedPercent: 59 }, now)?.state).toBe("on");
    expect(windowPace({ ...session, usedPercent: 62.5 }, now)?.state).toBe("ahead");
    expect(windowPace({ ...session, usedPercent: 57.5 }, now)?.state).toBe("under");
  });
});

describe("windowPace", () => {
  it("counts only the days the schedule counts", () => {
    // Wednesday noon: 2.5 of the 5 counted days are done, but only 2.5 of 7 calendar days.
    const now = at("2026-11-04T12:00:00Z");
    const pace = windowPace(weekly(50), now, weekdaysUtc)!;
    expect(pace.expectedUsedPercent).toBeCloseTo(50);
    expect(pace.state).toBe("on");
    expect(paceLabel(pace)).toBe("On pace");
    const plain = windowPace(weekly(50), now)!;
    expect(plain.expectedUsedPercent).toBeCloseTo((2.5 / 7) * 100);
    expect(plain.state).toBe("ahead");
  });

  it("stands still over a weekend the schedule leaves out", () => {
    const friday = windowPace(weekly(80), at("2026-11-07T00:00:00Z"), weekdaysUtc)!;
    const sunday = windowPace(weekly(80), at("2026-11-08T12:00:00Z"), weekdaysUtc)!;
    expect(friday.expectedUsedPercent).toBeCloseTo(100);
    expect(sunday.expectedUsedPercent).toBeCloseTo(100);
    expect(paceLabel(sunday)).toBe("20% in reserve");
  });

  it("says nothing in the first three percent of a window", () => {
    const start = at("2026-11-02T00:00:00Z");
    expect(windowPace(weekly(1), start + HOUR)).toBeNull();
    expect(windowPace(weekly(1), start + 5 * HOUR)).toBeNull();
    expect(windowPace(weekly(1), start + 6 * HOUR)).not.toBeNull();
    // Three percent of five counted days is 3.6 hours, not the 5 hours of a calendar week.
    expect(windowPace(weekly(1), at("2026-11-02T03:00:00Z"), weekdaysUtc)).toBeNull();
    expect(windowPace(weekly(1), at("2026-11-02T08:00:00Z"), weekdaysUtc)).not.toBeNull();
  });

  it("says nothing for a window that has reset, has no clock, or counts no time", () => {
    expect(windowPace(weekly(40), at("2026-11-09T00:00:00Z"))).toBeNull();
    expect(windowPace(weekly(40), at("2026-11-10T00:00:00Z"))).toBeNull();
    const { resetsAt: _resetsAt, ...undated } = weekly(40);
    expect(windowPace(undated, at("2026-11-04T00:00:00Z"))).toBeNull();
    const saturdays: LimitSchedule = { days: [6], timeZone: "UTC" };
    const shortWindow: ServerProviderUsageWindow = {
      ...weekly(40),
      kind: "session",
      windowDurationMins: 300,
      resetsAt: "2026-11-04T15:00:00.000Z",
    };
    expect(windowPace(shortWindow, at("2026-11-04T13:00:00Z"), saturdays)).toBeNull();
    expect(scheduledElapsedShare(shortWindow, at("2026-11-04T13:00:00Z"), saturdays)).toBeNull();
  });

  it("paces a monthly window that reports no length", () => {
    const cursor: ServerProviderUsageWindow = {
      id: "totalPercentUsed",
      kind: "monthly",
      label: "Overall",
      usedPercent: 30,
      resetsAt: "2026-11-15T00:00:00.000Z",
    };
    // 15 October to 15 November is 31 days; 14.5 have passed by the 29th at noon.
    const pace = windowPace(cursor, at("2026-10-29T12:00:00Z"))!;
    expect(pace.expectedUsedPercent).toBeCloseTo((14.5 / 31) * 100);
    expect(pace.state).toBe("under");
  });

  it("projects when the window runs out at the pace so far", () => {
    // 40% of the week gone, 60% spent: 2.8 days in, the rest lasts another 1.87.
    const now = at("2026-11-02T00:00:00Z") + 2.8 * DAY;
    const pace = windowPace(weekly(60), now)!;
    expect(pace.outlook).toEqual({
      kind: "runsOut",
      inMs: expect.closeTo((2 / 3) * 2.8 * DAY, -3),
    });
    expect(paceOutlook(pace)).toBe("Runs out in 1d 20h");
    expect(paceSummary(pace)).toBe("Pace: 20% in deficit | Expected 40% used | Runs out in 1d 20h");
    expect(windowPace(weekly(30), now)!.outlook).toEqual({ kind: "lasts" });
    expect(paceSummary(windowPace(weekly(30), now)!)).toBe(
      "Pace: 10% in reserve | Expected 40% used | Lasts until reset",
    );
    expect(windowPace(weekly(0), now)!.outlook).toEqual({ kind: "lasts" });
    expect(paceOutlook(windowPace(weekly(100), now)!)).toBe("Limit reached");
  });

  it("runs the projection over counted time, so a weekend does not use any up", () => {
    // Two weeks, Monday to Monday, Monday to Friday counted: 10 counted days in all.
    const fortnight = (usedPercent: number): ServerProviderUsageWindow => ({
      ...weekly(usedPercent),
      windowDurationMins: 14 * 24 * 60,
      resetsAt: "2026-11-16T00:00:00.000Z",
    });
    const friday = at("2026-11-06T12:00:00Z"); // 4.5 counted days in
    const pace = windowPace(fortnight(60), friday, weekdaysUtc)!;
    // 60% in 4.5 days leaves 3 more counted days: the first week's weekend adds none.
    expect(pace.outlook).toEqual({ kind: "runsOut", inMs: expect.closeTo(5 * DAY, -3) });
    expect(paceOutlook(pace)).toBe("Runs out in 5d 0h");
    // Counting the weekend as time to spend in, the same 60% would be gone in three days.
    expect(windowPace(fortnight(60), friday)!.outlook).toEqual({
      kind: "runsOut",
      inMs: expect.closeTo(3 * DAY, -3),
    });
  });

  it("puts the tick where even spending would have left the same share", () => {
    expect(scheduledPaceRemaining(weekly(10), at("2026-11-04T12:00:00Z"), weekdaysUtc)).toBe(50);
    expect(scheduledPaceRemaining(weekly(10), at("2026-11-04T12:00:00Z"))).toBe(64);
    expect(scheduledPaceRemaining(weekly(10), at("2026-11-02T01:00:00Z"))).toBeNull();
  });
});

describe("pooledPace", () => {
  const now = at("2026-11-04T12:00:00Z");

  it("keeps one account's own outlook", () => {
    expect(pooledPace([{ window: weekly(60), schedule: weekdaysUtc }], now)).toEqual(
      windowPace(weekly(60), now, weekdaysUtc),
    );
  });

  it("judges several accounts by their mean spend against their mean counted time", () => {
    const pace = pooledPace(
      [
        { window: weekly(80), schedule: weekdaysUtc },
        { window: weekly(20), schedule: weekdaysUtc },
      ],
      now,
    )!;
    expect(pace).toMatchObject({ state: "on", outlook: null });
    expect(pace.expectedUsedPercent).toBeCloseTo(50);
    expect(paceSummary(pace)).toBe("Pace: On pace | Expected 50% used");
  });

  it("lets each account follow its own schedule", () => {
    const pace = pooledPace(
      [{ window: weekly(50), schedule: weekdaysUtc }, { window: weekly(50) }],
      now,
    )!;
    expect(pace.expectedUsedPercent).toBeCloseTo((50 + (2.5 / 7) * 100) / 2);
  });

  it("leaves out windows without a clock and says nothing when none has one", () => {
    const { resetsAt: _resetsAt, ...undated } = weekly(90);
    expect(pooledPace([{ window: undated }], now)).toBeNull();
    const pace = pooledPace(
      [{ window: weekly(50), schedule: weekdaysUtc }, { window: undated }],
      now,
    );
    expect(pace?.state).toBe("on");
  });
});

describe("a window cleared before its reset", () => {
  // A reset credit on Wednesday noon; 4.5 days of the week were left.
  const credit: LimitReading = [at("2026-11-04T12:00:00Z"), 0];
  const thursdayNoon = at("2026-11-05T12:00:00Z");

  it("is paced from the clearing, not from the start of the window", () => {
    const pace = windowPace(weekly(10), thursdayNoon, undefined, { baseline: credit })!;
    expect(pace.expectedUsedPercent).toBeCloseTo((1 / 4.5) * 100);
    expect(paceLabel(pace)).toBe("12% in reserve");
    // Counted from Monday, half the week is gone and the same 10% looks far behind.
    expect(paceLabel(windowPace(weekly(10), thursdayNoon)!)).toBe("40% in reserve");
    expect(
      scheduledElapsedShare(weekly(10), thursdayNoon, undefined, { baseline: credit }),
    ).toBeCloseTo(1 / 4.5);
    expect(scheduledPaceRemaining(weekly(10), thursdayNoon, undefined, { baseline: credit })).toBe(
      78,
    );
  });

  it("projects from the spending since the clearing", () => {
    // 40% in the day since: another 1.5 days at that rate, though a run from Monday would last.
    const heavy = windowPace(weekly(40), thursdayNoon, undefined, { baseline: credit })!;
    expect(heavy.outlook).toEqual({ kind: "runsOut", inMs: expect.closeTo(1.5 * DAY, -3) });
    expect(windowPace(weekly(40), thursdayNoon)!.outlook).toEqual({ kind: "lasts" });
  });

  it("starts from whatever the window already held when it was first seen cleared", () => {
    const pace = windowPace(weekly(20), thursdayNoon, undefined, { baseline: [credit[0], 8] })!;
    expect(pace.expectedUsedPercent).toBeCloseTo(8 + 92 / 4.5);
    // Nothing spent since the clearing is not a rate.
    expect(
      windowPace(weekly(8), thursdayNoon, undefined, { baseline: [credit[0], 8] })!.outlook,
    ).toEqual({ kind: "lasts" });
  });

  it("says nothing in the first three percent after the clearing", () => {
    const soon = credit[0] + 2 * HOUR;
    expect(windowPace(weekly(1), soon, undefined, { baseline: credit })).toBeNull();
    expect(windowPace(weekly(1), soon)).not.toBeNull();
  });

  it("ignores a baseline that is not inside the window", () => {
    const before: LimitReading = [at("2026-10-30T00:00:00Z"), 0];
    const after: LimitReading = [at("2026-11-10T00:00:00Z"), 0];
    expect(windowPace(weekly(10), thursdayNoon, undefined, { baseline: before })).toEqual(
      windowPace(weekly(10), thursdayNoon),
    );
    expect(windowPace(weekly(10), thursdayNoon, undefined, { baseline: after })).toEqual(
      windowPace(weekly(10), thursdayNoon),
    );
  });

  it("is counted in schedule time from the clearing", () => {
    const friday: LimitReading = [at("2026-11-06T00:00:00Z"), 0];
    // Friday noon: half a counted day of the one left after the credit.
    const pace = windowPace(weekly(30), at("2026-11-06T12:00:00Z"), weekdaysUtc, {
      baseline: friday,
    })!;
    expect(pace.expectedUsedPercent).toBeCloseTo(50);
  });
});

describe("pace against the usual pattern", () => {
  const busyWeekdays = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 0, 7: 0 } as const;
  const everyDayUtc: LimitSchedule = { days: [1, 2, 3, 4, 5, 6, 7], timeZone: "UTC" };
  const wednesdayNoon = at("2026-11-04T12:00:00Z");

  it("expects use on the days it usually happens, not evenly", () => {
    // The weekend carries no weight, so by Wednesday noon half the pattern is done though only 2.5 of 7 days are.
    const usual = windowPace(weekly(50), wednesdayNoon, everyDayUtc, { weights: busyWeekdays })!;
    expect(usual).toMatchObject({ reference: "pattern", state: "on" });
    expect(usual.expectedUsedPercent).toBeCloseTo(50);
    const even = windowPace(weekly(50), wednesdayNoon, everyDayUtc)!;
    expect(even).toMatchObject({ reference: "even", state: "ahead" });
  });

  it("judges whether the window lasts against the same line", () => {
    const pace = windowPace(weekly(60), wednesdayNoon, everyDayUtc, { weights: busyWeekdays })!;
    expect(paceLabel(pace)).toBe("10% in deficit");
    // 60% by the middle of Wednesday leaves the other 40 until four on Friday morning.
    expect(pace.outlook).toEqual({ kind: "runsOut", inMs: expect.closeTo(40 * HOUR, -3) });
    expect(
      windowPace(weekly(40), wednesdayNoon, everyDayUtc, { weights: busyWeekdays })!.outlook,
    ).toEqual({
      kind: "lasts",
    });
  });

  it("falls back to even spending when the pattern puts nothing on the days that count", () => {
    const weekendsOnly = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 100, 7: 100 } as const;
    const pace = windowPace(weekly(50), wednesdayNoon, weekdaysUtc, { weights: weekendsOnly })!;
    expect(pace.reference).toBe("even");
    expect(pace.expectedUsedPercent).toBeCloseTo(50);
  });

  it("follows the pattern from a clearing, and pools accounts on their own lines", () => {
    const credit: LimitReading = [at("2026-11-03T00:00:00Z"), 0];
    const pace = windowPace(weekly(25), wednesdayNoon, everyDayUtc, {
      weights: busyWeekdays,
      baseline: credit,
    })!;
    // From Tuesday: 1.5 of the 4 weighted days that remain.
    expect(pace.expectedUsedPercent).toBeCloseTo((1.5 / 4) * 100);
    const pooled = pooledPace(
      [
        { window: weekly(50), schedule: everyDayUtc, weights: busyWeekdays },
        { window: weekly(50), schedule: everyDayUtc },
      ],
      wednesdayNoon,
    )!;
    expect(pooled.reference).toBe("even");
    expect(pooled.expectedUsedPercent).toBeCloseTo((50 + (2.5 / 7) * 100) / 2);
    expect(
      pooledPace(
        [{ window: weekly(50), schedule: everyDayUtc, weights: busyWeekdays }],
        wednesdayNoon,
      )!.reference,
    ).toBe("pattern");
  });
});
