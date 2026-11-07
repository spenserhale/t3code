// @effect-diagnostics globalDate:off -- Instants are listed from fixed epochs.
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
  limitDaysBetween,
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
    // A span of no length counts nothing, so there is no schedule to keep.
    expect(
      normalizeLimitSchedule({ days: [1, 2], hours: { start: 600, end: 600 } }),
    ).toBeUndefined();
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

describe("overnight hours", () => {
  const nights: LimitSchedule = {
    days: [1],
    hours: { start: 22 * 60, end: 6 * 60 },
    timeZone: "UTC",
  };

  it("are kept when the end is earlier than the start, with midnight read as the end of the day", () => {
    expect(normalizeLimitSchedule({ days: [1], hours: { start: 1320, end: 360 } })).toEqual({
      days: [1],
      hours: { start: 1320, end: 360 },
    });
    expect(normalizeLimitSchedule({ days: [1], hours: { start: 1320, end: 0 } })).toEqual({
      days: [1],
      hours: { start: 1320, end: 1440 },
    });
    expect(normalizeLimitSchedule({ days: [1], hours: { start: 0, end: 0 } })).toBeUndefined();
    expect(normalizeLimitSchedule({ days: [1], hours: { start: 1440, end: 60 } })).toEqual({
      days: [1],
    });
  });

  it("belong to the day they begin on and run into the next morning", () => {
    const timeline = limitTimeline(nights, at("2026-11-02T00:00:00Z"), at("2026-11-05T00:00:00Z"));
    expect(timeline.total).toBe(8 * HOUR);
    expect(timeline.massBefore(at("2026-11-02T22:00:00Z"))).toBe(0);
    expect(timeline.massBefore(at("2026-11-03T02:00:00Z"))).toBe(4 * HOUR);
    expect(timeline.massBefore(at("2026-11-04T00:00:00Z"))).toBe(8 * HOUR);
    expect(isLimitActiveAt(nights, at("2026-11-02T21:59:00Z"))).toBe(false);
    expect(isLimitActiveAt(nights, at("2026-11-02T22:00:00Z"))).toBe(true);
    expect(isLimitActiveAt(nights, at("2026-11-03T03:00:00Z"))).toBe(true);
    expect(isLimitActiveAt(nights, at("2026-11-03T06:00:00Z"))).toBe(false);
    // Tuesday night is not counted, so Wednesday morning is not either.
    expect(isLimitActiveAt(nights, at("2026-11-04T03:00:00Z"))).toBe(false);
  });

  it("count the part of a night that a window opens in the middle of", () => {
    const timeline = limitTimeline(nights, at("2026-11-03T03:00:00Z"), at("2026-11-03T12:00:00Z"));
    expect(timeline.total).toBe(3 * HOUR);
    expect(timeline.timeAtMass(HOUR)).toBe(at("2026-11-03T04:00:00Z"));
  });

  it("weigh the night by the day it begins on", () => {
    const weight = (day: number) => (day === 1 ? 5 : 100);
    const timeline = limitTimeline(
      nights,
      at("2026-11-02T00:00:00Z"),
      at("2026-11-04T00:00:00Z"),
      weight,
    );
    expect(timeline.total).toBe(5);
  });

  it("measure a counted day by its hours", () => {
    expect(limitActiveDayMs(nights)).toBe(8 * HOUR);
    expect(describeLimitSchedule(nights)).toBe("Mon, 22:00 to 6:00 (UTC)");
  });
});

describe("counting and the delivery gate", () => {
  const MINUTE = 60_000;
  // Walks a range a minute at a time: the schedule must be in session exactly when time is counted.
  const compare = (schedule: LimitSchedule, from: string, to: string) => {
    const start = at(from);
    const end = at(to);
    const timeline = limitTimeline(schedule, start, end);
    const disagreements: string[] = [];
    let inSession = 0;
    for (let instant = start; instant < end; instant += MINUTE) {
      const active = isLimitActiveAt(schedule, instant);
      const counted = timeline.massBefore(instant + MINUTE) - timeline.massBefore(instant);
      if (active !== (counted === MINUTE)) disagreements.push(new Date(instant).toISOString());
      if (active) inSession += 1;
    }
    return { disagreements, inSession, counted: timeline.total / MINUTE };
  };
  const newYork = "America/New_York";

  it("agree inside the hour a clock change skips", () => {
    const schedule: LimitSchedule = {
      days: [7],
      hours: { start: 150, end: 240 },
      timeZone: newYork,
    };
    // 02:30 does not exist on 8 March; counting starts when the clock reaches 03:30.
    expect(compare(schedule, "2026-03-08T04:00:00Z", "2026-03-09T05:00:00Z")).toEqual({
      disagreements: [],
      inSession: 30,
      counted: 30,
    });
    expect(isLimitActiveAt(schedule, at("2026-03-08T07:10:00Z"))).toBe(false); // 03:10
    expect(isLimitActiveAt(schedule, at("2026-03-08T07:30:00Z"))).toBe(true); // 03:30
  });

  it("agree inside the hour a clock change repeats", () => {
    const schedule: LimitSchedule = {
      days: [7],
      hours: { start: 90, end: 150 },
      timeZone: newYork,
    };
    // 01:30 comes twice on 1 November; counting runs from the first until 02:30 on the second pass.
    expect(compare(schedule, "2026-11-01T03:00:00Z", "2026-11-02T06:00:00Z")).toEqual({
      disagreements: [],
      inSession: 120,
      counted: 120,
    });
    expect(isLimitActiveAt(schedule, at("2026-11-01T05:10:00Z"))).toBe(false); // 01:10 EDT
    expect(isLimitActiveAt(schedule, at("2026-11-01T05:30:00Z"))).toBe(true); // 01:30 EDT
    expect(isLimitActiveAt(schedule, at("2026-11-01T06:10:00Z"))).toBe(true); // 01:10 EST
  });

  describe("in a zone east of Greenwich", () => {
    const berlin = "Europe/Berlin";

    it("agree inside the hour a clock change repeats, ending the stretch on the first pass", () => {
      const schedule: LimitSchedule = {
        days: [7],
        hours: { start: 90, end: 150 },
        timeZone: berlin,
      };
      // 02:30 comes twice on 25 October; 01:30 to 02:30 ends the first time, an hour after it began.
      expect(compare(schedule, "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z")).toEqual({
        disagreements: [],
        inSession: 60,
        counted: 60,
      });
      expect(isLimitActiveAt(schedule, at("2026-10-24T23:30:00Z"))).toBe(true); // 01:30 CEST
      expect(isLimitActiveAt(schedule, at("2026-10-25T00:15:00Z"))).toBe(true); // 02:15 CEST
      expect(isLimitActiveAt(schedule, at("2026-10-25T00:45:00Z"))).toBe(false); // 02:45 CEST
      expect(isLimitActiveAt(schedule, at("2026-10-25T01:45:00Z"))).toBe(false); // 02:45 CET
    });

    it("agree inside the hour a clock change skips", () => {
      const schedule: LimitSchedule = {
        days: [7],
        hours: { start: 150, end: 240 },
        timeZone: berlin,
      };
      // 02:30 does not exist on 29 March; counting starts when the clock reaches 03:30.
      expect(compare(schedule, "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z")).toEqual({
        disagreements: [],
        inSession: 30,
        counted: 30,
      });
    });
  });

  describe("a wall time that happens twice", () => {
    // Where each wall minute of a zone first occurs, and which come round again.
    const passes = (zone: string, from: string, to: string) => {
      const format = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const first = new Map<string, number>();
      const repeated = new Map<string, number>();
      for (let instant = at(from); instant < at(to); instant += MINUTE) {
        const parts = Object.fromEntries(
          format.formatToParts(instant).map((part) => [part.type, part.value]),
        );
        const key = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
        if (first.has(key)) repeated.set(key, Number(parts.hour) * 60 + Number(parts.minute));
        else first.set(key, instant);
      }
      return { first, repeated };
    };
    const zones = [
      ["America/New_York", "2026-11-01T00:00:00Z", "2026-11-02T06:00:00Z"],
      ["Europe/London", "2026-10-24T22:00:00Z", "2026-10-26T00:00:00Z"],
      ["Europe/Berlin", "2026-10-24T20:00:00Z", "2026-10-26T00:00:00Z"],
      ["Australia/Sydney", "2026-04-04T10:00:00Z", "2026-04-06T00:00:00Z"],
      ["Australia/Lord_Howe", "2026-04-04T10:00:00Z", "2026-04-06T00:00:00Z"],
      ["Pacific/Auckland", "2026-04-04T10:00:00Z", "2026-04-06T00:00:00Z"],
    ] as const;

    it.each(zones)("begins and ends a stretch at its first pass in %s", (zone, from, to) => {
      const { first, repeated } = passes(zone, from, to);
      const times = [...repeated].filter(([, minutes]) => minutes % 15 === 0);
      expect(times.length).toBeGreaterThan(0);
      const days: LimitSchedule["days"] = [1, 2, 3, 4, 5, 6, 7];
      for (const [key, minutes] of times) {
        const firstPass = first.get(key)!;
        const begins: LimitSchedule = {
          days,
          hours: { start: minutes, end: minutes + 15 },
          timeZone: zone,
        };
        expect(isLimitActiveAt(begins, firstPass - MINUTE), `${zone} ${key} begins`).toBe(false);
        expect(isLimitActiveAt(begins, firstPass), `${zone} ${key} begins`).toBe(true);
        const ends: LimitSchedule = {
          days,
          hours: { start: minutes - 15, end: minutes },
          timeZone: zone,
        };
        expect(isLimitActiveAt(ends, firstPass - MINUTE), `${zone} ${key} ends`).toBe(true);
        expect(isLimitActiveAt(ends, firstPass), `${zone} ${key} ends`).toBe(false);
        expect(isLimitActiveAt(ends, firstPass + 15 * MINUTE), `${zone} ${key} ends`).toBe(false);
      }
    });
  });

  it("agree over the short and long days", () => {
    const sunday: LimitSchedule = { days: [7], timeZone: newYork };
    expect(compare(sunday, "2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z")).toMatchObject({
      disagreements: [],
      counted: 23 * 60,
    });
    expect(compare(sunday, "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z")).toMatchObject({
      disagreements: [],
      counted: 25 * 60,
    });
  });

  it("agree over a night that crosses a clock change", () => {
    const saturdayNight: LimitSchedule = {
      days: [6],
      hours: { start: 22 * 60, end: 6 * 60 },
      timeZone: newYork,
    };
    // 22:00 to 06:00 is eight hours on the clock, seven when 02:00 to 03:00 is skipped, nine when repeated.
    expect(compare(saturdayNight, "2026-03-07T20:00:00Z", "2026-03-08T14:00:00Z")).toMatchObject({
      disagreements: [],
      counted: 7 * 60,
    });
    expect(compare(saturdayNight, "2026-10-31T20:00:00Z", "2026-11-01T14:00:00Z")).toMatchObject({
      disagreements: [],
      counted: 9 * 60,
    });
  });

  it("agree on working hours in a zone with a half-hour offset", () => {
    const india: LimitSchedule = { ...WORK_HOURS, timeZone: "Asia/Kolkata" };
    expect(compare(india, "2026-11-01T18:00:00Z", "2026-11-03T00:00:00Z")).toMatchObject({
      disagreements: [],
      counted: 8 * 60,
    });
  });
});

describe("limitDaysBetween", () => {
  it("lists the calendar days a stretch touches in the schedule's zone, each clipped to it", () => {
    const utc: LimitSchedule = { days: [1], timeZone: "UTC" };
    expect(limitDaysBetween(utc, at("2026-11-02T12:00:00Z"), at("2026-11-04T06:00:00Z"))).toEqual([
      { day: "2026-11-02", from: at("2026-11-02T12:00:00Z"), to: at("2026-11-03T00:00:00Z") },
      { day: "2026-11-03", from: at("2026-11-03T00:00:00Z"), to: at("2026-11-04T00:00:00Z") },
      { day: "2026-11-04", from: at("2026-11-04T00:00:00Z"), to: at("2026-11-04T06:00:00Z") },
    ]);
    expect(limitDaysBetween(utc, at("2026-11-02T12:00:00Z"), at("2026-11-02T12:00:00Z"))).toEqual(
      [],
    );
  });

  it("gives a day a clock change shortens or lengthens its real length", () => {
    const newYork: LimitSchedule = { days: [7], timeZone: "America/New_York" };
    const lengths = (from: string, to: string) =>
      limitDaysBetween(newYork, at(from), at(to)).map((entry) => [
        entry.day,
        (entry.to - entry.from) / HOUR,
      ]);
    expect(lengths("2026-03-07T05:00:00Z", "2026-03-10T04:00:00Z")).toEqual([
      ["2026-03-07", 24],
      ["2026-03-08", 23],
      ["2026-03-09", 24],
    ]);
    expect(lengths("2026-10-31T04:00:00Z", "2026-11-03T05:00:00Z")).toEqual([
      ["2026-10-31", 24],
      ["2026-11-01", 25],
      ["2026-11-02", 24],
    ]);
  });
});
