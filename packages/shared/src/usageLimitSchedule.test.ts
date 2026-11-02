import { describe, expect, it } from "vite-plus/test";

import {
  EVERY_DAY,
  WEEKDAYS,
  WORK_HOURS,
  deviceTimeZone,
  describeLimitSchedule,
  isLimitActiveAt,
  limitActiveDayMs,
  limitDayKey,
  limitSchedulePreset,
  limitTimeline,
  limitWeekdayAt,
  normalizeLimitSchedule,
  resolveTimeZone,
  type LimitSchedule,
} from "./usageLimitSchedule.ts";

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const utcWeekdays: LimitSchedule = { days: [1, 2, 3, 4, 5], timeZone: "UTC" };
const newYorkWork: LimitSchedule = { ...WORK_HOURS, timeZone: "America/New_York" };

describe("limitTimeline", () => {
  it("counts every hour without a schedule, and for one that counts every hour", () => {
    const start = at("2026-10-26T00:00:00Z");
    const end = at("2026-11-02T00:00:00Z");
    for (const schedule of [undefined, EVERY_DAY, { ...EVERY_DAY, timeZone: "Asia/Tokyo" }]) {
      const timeline = limitTimeline(schedule, start, end);
      expect(timeline.total).toBe(7 * DAY);
      expect(timeline.massBefore(start + 3 * DAY)).toBe(3 * DAY);
      expect(timeline.timeAtMass(2 * DAY)).toBe(start + 2 * DAY);
      expect(timeline.massBefore(start - DAY)).toBe(0);
      expect(timeline.massBefore(end + DAY)).toBe(7 * DAY);
    }
  });

  it("stands still over days the schedule leaves out", () => {
    const start = at("2026-10-26T00:00:00Z"); // Monday
    const timeline = limitTimeline(utcWeekdays, start, at("2026-11-02T00:00:00Z"));
    expect(timeline.total).toBe(5 * DAY);
    expect(timeline.massBefore(at("2026-10-28T12:00:00Z"))).toBe(2.5 * DAY);
    expect(timeline.massBefore(at("2026-10-31T12:00:00Z"))).toBe(5 * DAY);
    expect(timeline.massBefore(at("2026-11-01T23:00:00Z"))).toBe(5 * DAY);
    expect(timeline.timeAtMass(2.5 * DAY)).toBe(at("2026-10-28T12:00:00Z"));
    expect(timeline.timeAtMass(5 * DAY)).toBe(at("2026-10-31T00:00:00Z"));
    expect(timeline.timeAtMass(6 * DAY)).toBe(at("2026-11-02T00:00:00Z"));
  });

  it("counts a window that starts in the middle of a counted day only from there", () => {
    const timeline = limitTimeline(
      utcWeekdays,
      at("2026-10-30T18:00:00Z"), // Friday evening
      at("2026-11-03T06:00:00Z"), // Tuesday morning
    );
    expect(timeline.total).toBe(6 * HOUR + DAY + 6 * HOUR);
    expect(timeline.massBefore(at("2026-11-02T00:00:00Z"))).toBe(6 * HOUR);
  });

  it("counts the daily hours only, in the schedule's zone", () => {
    // 9 to 17 in New York is 14 to 22 UTC in winter and 13 to 21 UTC in summer time.
    const winter = limitTimeline(
      newYorkWork,
      at("2026-11-02T00:00:00Z"),
      at("2026-11-03T00:00:00Z"),
    );
    expect(winter.total).toBe(8 * HOUR);
    expect(winter.massBefore(at("2026-11-02T14:00:00Z"))).toBe(0);
    expect(winter.massBefore(at("2026-11-02T18:00:00Z"))).toBe(4 * HOUR);
    expect(winter.timeAtMass(4 * HOUR)).toBe(at("2026-11-02T18:00:00Z"));
    const summer = limitTimeline(
      newYorkWork,
      at("2026-07-06T00:00:00Z"),
      at("2026-07-07T00:00:00Z"),
    );
    expect(summer.massBefore(at("2026-07-06T13:00:00Z"))).toBe(0);
    expect(summer.massBefore(at("2026-07-06T21:00:00Z"))).toBe(8 * HOUR);
  });

  it("keeps the hours steady across the clock change into summer time", () => {
    // Friday 6 March is EST, Monday 9 March is EDT; the weekend between is not counted.
    const timeline = limitTimeline(
      newYorkWork,
      at("2026-03-06T00:00:00Z"),
      at("2026-03-10T12:00:00Z"),
    );
    expect(timeline.total).toBe(16 * HOUR);
    expect(timeline.massBefore(at("2026-03-06T22:00:00Z"))).toBe(8 * HOUR);
    expect(timeline.massBefore(at("2026-03-09T13:00:00Z"))).toBe(8 * HOUR);
    expect(timeline.massBefore(at("2026-03-09T17:00:00Z"))).toBe(12 * HOUR);
  });

  it("counts the real length of the days a clock change shortens or lengthens", () => {
    const sunday: LimitSchedule = { days: [7], timeZone: "America/New_York" };
    expect(
      limitTimeline(sunday, at("2026-03-07T00:00:00Z"), at("2026-03-10T00:00:00Z")).total,
    ).toBe(23 * HOUR);
    expect(
      limitTimeline(sunday, at("2026-10-31T00:00:00Z"), at("2026-11-03T00:00:00Z")).total,
    ).toBe(25 * HOUR);
  });

  it("moves an hour a clock change skips to just after the change, and counts nothing in it", () => {
    const sunday: LimitSchedule = {
      days: [7],
      hours: { start: 2 * 60, end: 3 * 60 },
      timeZone: "America/New_York",
    };
    const skipped = limitTimeline(sunday, at("2026-03-08T00:00:00Z"), at("2026-03-09T00:00:00Z"));
    expect(skipped.total).toBe(0);
    expect(skipped.timeAtMass(1)).toBe(at("2026-03-09T00:00:00Z"));
    const twice = limitTimeline(
      { ...sunday, hours: { start: 90, end: 150 } },
      at("2026-11-01T00:00:00Z"),
      at("2026-11-02T12:00:00Z"),
    );
    // 01:30 happens twice; the first is 05:30 UTC and the hour runs on to 02:30 EST (07:30 UTC).
    expect(twice.breakpoints.some((point) => point.at === at("2026-11-01T05:30:00Z"))).toBe(true);
    expect(twice.total).toBe(2 * HOUR);
  });

  it("reads zones with a half-hour offset", () => {
    const india: LimitSchedule = { ...WORK_HOURS, timeZone: "Asia/Kolkata" };
    const timeline = limitTimeline(india, at("2026-11-02T00:00:00Z"), at("2026-11-03T00:00:00Z"));
    expect(timeline.total).toBe(8 * HOUR);
    expect(timeline.massBefore(at("2026-11-02T03:30:00Z"))).toBe(0);
    expect(timeline.massBefore(at("2026-11-02T07:30:00Z"))).toBe(4 * HOUR);
  });

  it("scales each counted day by its weight and spreads it over the day's counted hours", () => {
    const weight = (day: number) => (day === 1 ? 1 : day === 2 ? 3 : 0);
    const timeline = limitTimeline(
      { days: [1, 2, 3], timeZone: "UTC" },
      at("2026-11-02T00:00:00Z"),
      at("2026-11-05T00:00:00Z"),
      weight,
    );
    expect(timeline.total).toBe(4);
    expect(timeline.massBefore(at("2026-11-02T12:00:00Z"))).toBeCloseTo(0.5);
    expect(timeline.massBefore(at("2026-11-03T00:00:00Z"))).toBeCloseTo(1);
    expect(timeline.massBefore(at("2026-11-03T12:00:00Z"))).toBeCloseTo(2.5);
    expect(timeline.timeAtMass(2.5)).toBe(at("2026-11-03T12:00:00Z"));
    expect(timeline.timeAtMass(100)).toBe(at("2026-11-05T00:00:00Z"));
  });

  it("weighs a window that opens mid-day by the part of the day it holds", () => {
    const timeline = limitTimeline(
      { days: [1], timeZone: "UTC" },
      at("2026-11-02T12:00:00Z"),
      at("2026-11-03T00:00:00Z"),
      () => 10,
    );
    expect(timeline.total).toBe(5);
  });

  it("lists where the curve bends, flat between counted stretches", () => {
    const timeline = limitTimeline(
      utcWeekdays,
      at("2026-10-30T00:00:00Z"),
      at("2026-11-03T00:00:00Z"),
    );
    expect(timeline.breakpoints.map((point) => [point.at, point.mass / DAY])).toEqual([
      [at("2026-10-30T00:00:00Z"), 0],
      [at("2026-10-31T00:00:00Z"), 1],
      [at("2026-11-02T00:00:00Z"), 1],
      [at("2026-11-03T00:00:00Z"), 2],
    ]);
  });

  it("is empty for a window with no length", () => {
    const timeline = limitTimeline(
      utcWeekdays,
      at("2026-11-02T00:00:00Z"),
      at("2026-11-02T00:00:00Z"),
    );
    expect(timeline.total).toBe(0);
    expect(timeline.massBefore(at("2026-11-02T00:00:00Z"))).toBe(0);
  });

  it("counts every hour of a window too long to walk day by day", () => {
    const start = at("2026-01-01T00:00:00Z");
    const timeline = limitTimeline(utcWeekdays, start, start + 500 * DAY);
    expect(timeline.total).toBe(500 * DAY);
  });
});

describe("isLimitActiveAt", () => {
  it("honours the days and the hours in the schedule's own zone", () => {
    expect(isLimitActiveAt(newYorkWork, at("2026-11-02T13:59:00Z"))).toBe(false); // 08:59 Monday
    expect(isLimitActiveAt(newYorkWork, at("2026-11-02T14:00:00Z"))).toBe(true); // 09:00
    expect(isLimitActiveAt(newYorkWork, at("2026-11-02T21:59:00Z"))).toBe(true); // 16:59
    expect(isLimitActiveAt(newYorkWork, at("2026-11-02T22:00:00Z"))).toBe(false); // 17:00
    expect(isLimitActiveAt(newYorkWork, at("2026-11-01T16:00:00Z"))).toBe(false); // Sunday
    // Tuesday in UTC, still Monday evening in New York.
    expect(isLimitActiveAt(utcWeekdays, at("2026-11-03T02:00:00Z"))).toBe(true);
    expect(
      isLimitActiveAt({ days: [1], timeZone: "America/New_York" }, at("2026-11-03T02:00:00Z")),
    ).toBe(true);
    expect(
      isLimitActiveAt({ days: [2], timeZone: "America/New_York" }, at("2026-11-03T02:00:00Z")),
    ).toBe(false);
  });

  it("is always true without a schedule", () => {
    expect(isLimitActiveAt(undefined, at("2026-11-01T03:00:00Z"))).toBe(true);
    expect(isLimitActiveAt(EVERY_DAY, at("2026-11-01T03:00:00Z"))).toBe(true);
  });
});

describe("calendar days", () => {
  it("names the day and weekday an instant falls on in the schedule's zone", () => {
    const instant = at("2026-11-03T02:00:00Z");
    expect(limitDayKey({ days: [1], timeZone: "UTC" }, instant)).toBe("2026-11-03");
    expect(limitDayKey({ days: [1], timeZone: "America/New_York" }, instant)).toBe("2026-11-02");
    expect(limitWeekdayAt({ days: [1], timeZone: "America/New_York" }, instant)).toBe(1);
    expect(limitWeekdayAt({ days: [1], timeZone: "UTC" }, instant)).toBe(2);
    expect(limitWeekdayAt({ days: [1], timeZone: "UTC" }, at("2026-11-01T12:00:00Z"))).toBe(7);
  });

  it("falls back to the device's zone", () => {
    expect(resolveTimeZone(undefined)).toBe(deviceTimeZone());
    expect(resolveTimeZone({ days: [1], timeZone: "Not/AZone" })).toBe(deviceTimeZone());
  });

  it("measures an active day by its hours", () => {
    expect(limitActiveDayMs(undefined)).toBe(DAY);
    expect(limitActiveDayMs(WEEKDAYS)).toBe(DAY);
    expect(limitActiveDayMs(WORK_HOURS)).toBe(8 * HOUR);
  });
});

describe("normalizeLimitSchedule", () => {
  it("orders and deduplicates days, and drops what cannot be used", () => {
    expect(
      normalizeLimitSchedule({
        days: [5, 1, 1, 9, 0, "2", 3],
        hours: { start: 540, end: 1020 },
        timeZone: "Europe/Berlin",
      }),
    ).toEqual({
      days: [1, 3, 5],
      hours: { start: 540, end: 1020 },
      timeZone: "Europe/Berlin",
    });
    expect(normalizeLimitSchedule({ days: [1, 2], hours: { start: 600, end: 600 } })).toEqual({
      days: [1, 2],
    });
    expect(normalizeLimitSchedule({ days: [1], hours: { start: 0, end: 1440 } })).toEqual({
      days: [1],
    });
    expect(normalizeLimitSchedule({ days: [1], hours: { start: 480, end: 1441 } })).toEqual({
      days: [1],
    });
    expect(normalizeLimitSchedule({ days: [1], timeZone: "Not/AZone" })).toEqual({ days: [1] });
  });

  it.each([null, undefined, 3, "x", {}, { days: [] }, { days: "1" }, { days: [8, 0] }])(
    "has no schedule for %j",
    (value) => {
      expect(normalizeLimitSchedule(value)).toBeUndefined();
    },
  );
});

describe("describing schedules", () => {
  it.each([
    [undefined, "Every day", "everyDay"],
    [EVERY_DAY, "Every day", "everyDay"],
    [WEEKDAYS, "Mon to Fri", "weekdays"],
    [WORK_HOURS, "Mon to Fri, 9:00 to 17:00", "workHours"],
    [{ days: [1, 3, 5] }, "Mon, Wed, Fri", "custom"],
    [{ days: [6, 7] }, "Sat, Sun", "custom"],
    [{ days: [1, 2, 3, 4, 5, 6] }, "Mon to Sat", "custom"],
    [
      { days: [1, 2, 3, 4, 5], hours: { start: 510, end: 1050 }, timeZone: "Europe/Berlin" },
      "Mon to Fri, 8:30 to 17:30 (Europe/Berlin)",
      "custom",
    ],
    [{ ...WEEKDAYS, timeZone: "UTC" }, "Mon to Fri (UTC)", "custom"],
    [
      { days: [1, 2, 3, 4, 5], hours: { start: 480, end: 1020 } },
      "Mon to Fri, 8:00 to 17:00",
      "custom",
    ],
  ] as const)("%j reads %s as the %s preset", (schedule, text, preset) => {
    expect(describeLimitSchedule(schedule as LimitSchedule | undefined)).toBe(text);
    expect(limitSchedulePreset(schedule as LimitSchedule | undefined)).toBe(preset);
  });
});
