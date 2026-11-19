// @effect-diagnostics globalDate:off -- Fixtures are built from fixed instants.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type DailyTokens,
  burnDownChart,
  dailyBurn,
  forecastSentence,
  forecastWindow,
  paceDetailFor,
  trendRate,
  weekdayWeights,
} from "./usageLimitForecast.ts";
import type { LimitInstance } from "./usageLimitHistory.ts";
import type { LimitAccount } from "./usageLimits.ts";
import type { LimitSchedule } from "./usageLimitSchedule.ts";

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const monday = at("2026-11-02T00:00:00Z");
const reset = monday + 7 * DAY;
const wednesdayNoon = monday + 2.5 * DAY;

const everyDayUtc: LimitSchedule = { days: [1, 2, 3, 4, 5, 6, 7], timeZone: "UTC" };
const weekdaysUtc: LimitSchedule = { days: [1, 2, 3, 4, 5], timeZone: "UTC" };

const weekly = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: new Date(reset).toISOString(),
});

const run = (
  usedPercent: number,
  now: number,
  options: Partial<Parameters<typeof forecastWindow>[0]> = {},
) => forecastWindow({ window: weekly(usedPercent), now, algorithm: "runRate", ...options });

describe("run rate", () => {
  it("spreads the spend so far over the time so far", () => {
    const { forecast, note } = run(20, wednesdayNoon);
    expect(note).toBeNull();
    expect(forecast).toMatchObject({ algorithm: "runRate", runsOutAt: null });
    expect(forecast!.projectedUsedPercent).toBeCloseTo(56);
    expect(forecast!.unusedPercent).toBeCloseTo(44);
    expect(forecast!.curve).toEqual([
      { at: wednesdayNoon, usedPercent: 20 },
      { at: reset, usedPercent: expect.closeTo(56, 5) },
    ]);
  });

  it("finds when the window runs out and holds the curve at 100 from there", () => {
    const { forecast } = run(50, wednesdayNoon);
    expect(forecast!.projectedUsedPercent).toBeCloseTo(140);
    expect(forecast!.unusedPercent).toBe(0);
    expect(forecast!.runsOutAt).toBeCloseTo(monday + 5 * DAY, -1);
    expect(forecast!.curve).toEqual([
      { at: wednesdayNoon, usedPercent: 50 },
      { at: forecast!.runsOutAt, usedPercent: 100 },
      { at: reset, usedPercent: 100 },
    ]);
  });

  it("counts only the time the schedule counts, and stands still over a weekend", () => {
    // Wednesday noon is halfway through five counted days.
    const onPace = run(50, wednesdayNoon, { schedule: weekdaysUtc }).forecast!;
    expect(onPace.projectedUsedPercent).toBeCloseTo(100);
    expect(onPace.runsOutAt).toBeNull();
    const behind = run(40, wednesdayNoon, { schedule: weekdaysUtc }).forecast!;
    expect(behind.projectedUsedPercent).toBeCloseTo(80);
    expect(behind.unusedPercent).toBeCloseTo(20);
    expect(behind.curve.map((point) => [point.at, Math.round(point.usedPercent)])).toEqual([
      [wednesdayNoon, 40],
      [monday + 5 * DAY, 80],
      [reset, 80],
    ]);
    const ahead = run(60, wednesdayNoon, { schedule: weekdaysUtc }).forecast!;
    // 60% by the middle of Wednesday is 24 points a day, so the other 40 take another 1.67 days.
    expect(ahead.runsOutAt).toBeCloseTo(monday + (2.5 + 40 / 24) * DAY, -1);
  });

  it("makes no forecast for a window that is too young, undated, or over", () => {
    expect(run(1, monday + 2 * HOUR)).toEqual({ forecast: null, note: "tooEarly" });
    const { resetsAt: _resetsAt, ...undated } = weekly(10);
    expect(forecastWindow({ window: undated, now: wednesdayNoon, algorithm: "runRate" })).toEqual({
      forecast: null,
      note: "noReset",
    });
    expect(run(10, reset + HOUR)).toEqual({ forecast: null, note: "ended" });
    // A window the schedule leaves out altogether has no time to spend in.
    const saturdays: LimitSchedule = { days: [6], timeZone: "UTC" };
    const shortWindow = { ...weekly(10), kind: "session", windowDurationMins: 300 } as const;
    expect(
      forecastWindow({
        window: { ...shortWindow, resetsAt: new Date(monday + 17 * HOUR).toISOString() },
        now: monday + 15 * HOUR,
        algorithm: "runRate",
        schedule: saturdays,
      }),
    ).toEqual({ forecast: null, note: "outsideSchedule" });
  });

  it("forecasts a spent window as out of allowance now", () => {
    const { forecast } = run(100, wednesdayNoon);
    expect(forecast).toMatchObject({ runsOutAt: wednesdayNoon, unusedPercent: 0 });
  });

  it("calls spending that ends exactly at 100 at the reset using all of it, not running out", () => {
    const { forecast } = run(50, wednesdayNoon, { schedule: weekdaysUtc });
    expect(forecast!.runsOutAt).toBeNull();
    expect(forecastSentence(forecast!, String)).toBe("On track to use nearly all of it");
  });
});

describe("weekday pattern", () => {
  // Four weeks and a bit, busy on weekdays only: Monday 5 October to Wednesday 4 November.
  const busyWeekdays: DailyTokens[] = Array.from({ length: 31 }, (_, offset) => {
    const date = new Date(Date.UTC(2026, 9, 5 + offset));
    return {
      day: date.toISOString().slice(0, 10),
      tokens: date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 0 : 100,
    };
  });

  it("expects spending to follow the weekdays the provider is actually used on", () => {
    // Half of the week's busy days are over by Wednesday noon, though only 2.5 of 7 calendar days are.
    const { forecast, note } = run(50, wednesdayNoon, {
      algorithm: "weekday",
      schedule: everyDayUtc,
      dailyTokens: busyWeekdays,
    });
    expect(note).toBeNull();
    expect(forecast).toMatchObject({ algorithm: "weekday", runsOutAt: null });
    expect(forecast!.projectedUsedPercent).toBeCloseTo(100);
    expect(
      run(50, wednesdayNoon, { schedule: everyDayUtc }).forecast!.projectedUsedPercent,
    ).toBeCloseTo(140);
  });

  it("falls back to the run rate with under two weeks of token history", () => {
    const outcome = run(50, wednesdayNoon, {
      algorithm: "weekday",
      schedule: everyDayUtc,
      dailyTokens: busyWeekdays.slice(-13),
    });
    expect(outcome.note).toBe("weekdayNeedsTokens");
    expect(outcome.forecast?.algorithm).toBe("runRate");
    expect(run(50, wednesdayNoon, { algorithm: "weekday", schedule: everyDayUtc }).note).toBe(
      "weekdayNeedsTokens",
    );
  });

  it("falls back to the run rate when the busy days have not come yet", () => {
    const thursdaysOnly = busyWeekdays.map((entry) => ({
      ...entry,
      tokens: new Date(`${entry.day}T00:00:00Z`).getUTCDay() === 4 ? 100 : 0,
    }));
    const outcome = run(5, monday + 12 * HOUR, {
      algorithm: "weekday",
      schedule: everyDayUtc,
      dailyTokens: thursdaysOnly,
    });
    expect(outcome.note).toBe("weekdayTooEarly");
    expect(outcome.forecast?.algorithm).toBe("runRate");
  });

  it("measures each weekday by its mean over the days since the first with use", () => {
    const weights = weekdayWeights(busyWeekdays, "2026-11-04", [1, 2, 3, 4, 5, 6, 7])!;
    expect(weights).toEqual({ 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 0, 7: 0 });
    // Today's total is not in yet, so it is neither a busy day nor a quiet one.
    const withToday = [...busyWeekdays, { day: "2026-11-05", tokens: 1_000_000 }];
    expect(weekdayWeights(withToday, "2026-11-05", [1, 2, 3, 4, 5, 6, 7])).toEqual(weights);
    // A day with no record is a day of none: four busy Mondays out of five make 80.
    const gaps = busyWeekdays.filter((entry) => entry.day !== "2026-10-19");
    expect(weekdayWeights(gaps, "2026-11-04", [1])![1]).toBeCloseTo(80);
  });

  it("needs two weeks of whole days since the first with use, ignores totals older than 90 days, and use on the counted days", () => {
    expect(weekdayWeights(busyWeekdays, "2026-10-18", [1, 2, 3, 4, 5])).toBeNull();
    expect(weekdayWeights(busyWeekdays, "2026-10-19", [1, 2, 3, 4, 5])).not.toBeNull();
    expect(weekdayWeights([{ day: "2026-01-02", tokens: 500 }], "2026-11-04", [1])).toBeNull();
    expect(weekdayWeights([], "2026-11-04", [1])).toBeNull();
    // Only weekends saw use, and the schedule counts weekdays.
    const weekendsOnly = busyWeekdays.map((entry) => ({
      ...entry,
      tokens: entry.tokens === 0 ? 100 : 0,
    }));
    expect(weekdayWeights(weekendsOnly, "2026-11-04", [1, 2, 3, 4, 5])).toBeNull();
    expect(weekdayWeights(weekendsOnly, "2026-11-04", [6, 7])).not.toBeNull();
  });
});

describe("recent trend", () => {
  const instance = (...readings: Array<[number, number]>): LimitInstance => ({
    resetsAt: reset,
    from: readings[0]![0],
    readings,
  });
  const thursday = monday + 3 * DAY;

  it("leans on the recent rate, with older days counting for less", () => {
    // 5 points a day on Monday and Tuesday, then 20 on Wednesday.
    const recorded = instance(
      [monday, 0],
      [monday + DAY, 5],
      [monday + 2 * DAY, 10],
      [thursday, 30],
    );
    const weight = (ageDays: number) => 0.5 ** (ageDays / 3);
    const rate = (5 * weight(2) + 5 * weight(1) + 20) / (weight(2) + weight(1) + 1) / DAY;
    expect(trendRate([recorded], thursday, everyDayUtc)).toBeCloseTo(rate, 12);
    const { forecast, note } = run(30, thursday, { algorithm: "trend", instances: [recorded] });
    expect(note).toBeNull();
    expect(forecast!.algorithm).toBe("trend");
    expect(forecast!.projectedUsedPercent).toBeCloseTo(30 + rate * 4 * DAY, 6);
    // The plain run rate would say 70.
    expect(forecast!.projectedUsedPercent).toBeGreaterThan(70);
  });

  it("counts only the time the schedule counts between readings", () => {
    // Friday noon to Monday noon is one counted day, 12 hours either side of the weekend.
    const friday = at("2026-11-06T12:00:00Z");
    const recorded = instance([friday, 20], [friday + 3 * DAY, 30]);
    expect(trendRate([recorded], friday + 3 * DAY, weekdaysUtc)).toBeCloseTo(10 / DAY, 12);
    expect(trendRate([recorded], friday + 3 * DAY, everyDayUtc)).toBeCloseTo(10 / (3 * DAY), 12);
  });

  it("learns nothing from the weekend when the schedule leaves it out", () => {
    const saturday = at("2026-11-07T00:00:00Z");
    const weekend = instance([saturday, 20], [saturday + DAY, 60]);
    expect(trendRate([weekend], saturday + DAY, weekdaysUtc)).toBeNull();
  });

  it("needs half a counted day of readings", () => {
    expect(trendRate([instance([monday, 0])], thursday, everyDayUtc)).toBeNull();
    expect(
      trendRate([instance([monday, 0], [monday + 6 * HOUR, 5])], thursday, everyDayUtc),
    ).toBeNull();
    expect(
      trendRate([instance([thursday - 12 * HOUR, 0], [thursday, 5])], thursday, everyDayUtc),
    ).not.toBeNull();
  });

  it("ignores readings older than two weeks and never joins two instances", () => {
    const old = instance([monday - 20 * DAY, 0], [monday - 19 * DAY, 90]);
    const other = { ...instance([thursday - DAY, 10], [thursday, 15]), from: thursday - DAY };
    expect(trendRate([old], thursday, everyDayUtc)).toBeNull();
    // Each instance is judged alone: the 10 point drop between them is not a negative rate.
    const joined = trendRate(
      [instance([thursday - 2 * DAY, 60], [thursday - DAY, 80]), other],
      thursday,
      everyDayUtc,
    );
    expect(joined).toBeCloseTo((0.5 ** (1 / 3) * 20 + 5) / (0.5 ** (1 / 3) + 1) / DAY, 12);
  });

  it("falls back to the run rate without enough readings", () => {
    const outcome = run(30, thursday, { algorithm: "trend", instances: [instance([monday, 0])] });
    expect(outcome.note).toBe("trendNeedsReadings");
    expect(outcome.forecast?.algorithm).toBe("runRate");
    expect(run(30, thursday, { algorithm: "trend" }).note).toBe("trendNeedsReadings");
  });

  it("forecasts a window that is too young for the run rate from its readings", () => {
    const soon = monday + 4 * HOUR;
    const recorded = instance(
      [monday - 3 * DAY, 10],
      [monday - 2 * DAY, 20],
      [monday - DAY, 30],
      [monday, 0],
    );
    const { forecast } = run(1, soon, { algorithm: "trend", instances: [recorded] });
    expect(forecast?.algorithm).toBe("trend");
  });
});

describe("forecastSentence", () => {
  const formatTime = (instant: number) => new Date(instant).toISOString().slice(5, 16);

  it("says when the window runs out, or how much will go unused", () => {
    expect(forecastSentence(run(50, wednesdayNoon).forecast!, formatTime)).toBe(
      "On track to run out 11-07T00:00",
    );
    expect(forecastSentence(run(20, wednesdayNoon).forecast!, formatTime)).toBe(
      "On track to leave ~45% unused",
    );
    expect(
      forecastSentence(run(40, wednesdayNoon, { schedule: weekdaysUtc }).forecast!, formatTime),
    ).toBe("On track to leave ~20% unused");
    expect(
      forecastSentence(run(49, wednesdayNoon, { schedule: weekdaysUtc }).forecast!, formatTime),
    ).toBe("On track to use nearly all of it");
  });
});

describe("burnDownChart", () => {
  const recorded: LimitInstance = {
    resetsAt: reset,
    from: monday + HOUR,
    readings: [
      [monday + HOUR, 1],
      [monday + DAY, 10],
      [wednesdayNoon - 3 * HOUR, 40],
    ],
  };

  it("draws an even line that stands still over the days the schedule leaves out", () => {
    const chart = burnDownChart({
      window: weekly(45),
      checkedAt: wednesdayNoon,
      schedule: weekdaysUtc,
      instance: recorded,
    })!;
    expect(chart.start).toBe(monday);
    expect(chart.end).toBe(reset);
    expect(chart.referenceKind).toBe("even");
    expect(chart.reference).toEqual([
      { at: monday, remainingPercent: 100 },
      { at: monday + 5 * DAY, remainingPercent: 0 },
      { at: reset, remainingPercent: 0 },
    ]);
  });

  it("charts the recorded readings and the one in hand, as what is left", () => {
    const chart = burnDownChart({
      window: weekly(45),
      checkedAt: wednesdayNoon - HOUR,
      instance: recorded,
      forecast: run(45, wednesdayNoon).forecast,
    })!;
    expect(chart.readings).toEqual([
      { at: monday + HOUR, remainingPercent: 99 },
      { at: monday + DAY, remainingPercent: 90 },
      { at: wednesdayNoon - 3 * HOUR, remainingPercent: 60 },
      { at: wednesdayNoon - HOUR, remainingPercent: 55 },
    ]);
    expect(chart.forecast[0]).toEqual({ at: wednesdayNoon, remainingPercent: 55 });
    expect(chart.reference).toHaveLength(2);
  });

  it("leaves out the readings of an earlier window and still charts the one in hand", () => {
    const chart = burnDownChart({
      window: weekly(5),
      checkedAt: wednesdayNoon,
      instance: { ...recorded, resetsAt: reset - 7 * DAY },
    })!;
    expect(chart.readings).toEqual([{ at: wednesdayNoon, remainingPercent: 95 }]);
    expect(chart.forecast).toEqual([]);
  });

  it("has nothing to draw for a window with no span", () => {
    const { resetsAt: _resetsAt, ...undated } = weekly(10);
    expect(burnDownChart({ window: undated, checkedAt: wednesdayNoon })).toBeNull();
  });
});

describe("a window cleared before its reset", () => {
  // A reset credit at Wednesday noon cleared 70% of the week's allowance.
  const credit = wednesdayNoon;
  const thursdayNoon = monday + 3.5 * DAY;
  const cleared: LimitInstance[] = [
    {
      resetsAt: reset,
      from: monday,
      readings: [
        [monday, 0],
        [credit - HOUR, 70],
      ],
    },
    {
      resetsAt: reset,
      from: credit,
      baseline: [credit, 0],
      readings: [
        [credit, 0],
        [thursdayNoon, 10],
      ],
    },
  ];

  it("counts the run rate from the clearing, not from the start of the window", () => {
    // 10% in the day since the credit, with 3.5 days to go.
    expect(
      run(10, thursdayNoon, { instances: cleared }).forecast!.projectedUsedPercent,
    ).toBeCloseTo(45);
    // Counted from Monday the same reading looks like a slow week.
    expect(run(10, thursdayNoon).forecast!.projectedUsedPercent).toBeCloseTo(20);
  });

  it("counts the weekday pattern from the clearing, and so does its fallback", () => {
    const busy = Array.from({ length: 31 }, (_, offset) => {
      const date = new Date(Date.UTC(2026, 9, 5 + offset));
      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
      return { day: date.toISOString().slice(0, 10), tokens: weekend ? 0 : 100 };
    });
    const weekday = run(10, thursdayNoon, {
      algorithm: "weekday",
      schedule: everyDayUtc,
      dailyTokens: busy,
      instances: cleared,
    });
    // 100 of the 250 weighted units that remained after the credit have passed.
    expect(weekday.forecast!.projectedUsedPercent).toBeCloseTo(25);
    const fallback = run(10, thursdayNoon, {
      algorithm: "weekday",
      schedule: everyDayUtc,
      instances: cleared,
    });
    expect(fallback.note).toBe("weekdayNeedsTokens");
    expect(fallback.forecast!.projectedUsedPercent).toBeCloseTo(45);
  });

  it("reads the trend from the readings alone, the drop at the clearing being no rate", () => {
    const { forecast } = run(10, thursdayNoon, { algorithm: "trend", instances: cleared });
    expect(forecast!.algorithm).toBe("trend");
    const rate = trendRate(cleared, thursdayNoon, undefined)!;
    expect(rate).toBeGreaterThan(0);
    expect(forecast!.projectedUsedPercent).toBeCloseTo(10 + rate * (reset - thursdayNoon));
  });

  it("starts the chart there, with the allowance that was left", () => {
    const chart = burnDownChart({
      window: weekly(10),
      checkedAt: thursdayNoon,
      baseline: [credit, 5],
      instance: cleared[1],
    })!;
    expect(chart.start).toBe(credit);
    expect(chart.reference[0]).toEqual({ at: credit, remainingPercent: 95 });
    expect(chart.reference.at(-1)).toEqual({ at: reset, remainingPercent: 0 });
    expect(chart.readings.map((reading) => reading.at)).toEqual([credit, thursdayNoon]);
  });
});

describe("the chart's reference line", () => {
  const busyWeekdays = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 0, 7: 0 } as const;
  const chartOf = (
    weights: Parameters<typeof burnDownChart>[0]["weights"],
    schedule = everyDayUtc,
  ) =>
    burnDownChart({
      window: weekly(45),
      checkedAt: wednesdayNoon,
      schedule,
      weights,
    })!;

  it("is the usual pattern when it is known, flat over the days it puts nothing on", () => {
    const chart = chartOf(busyWeekdays);
    expect(chart.referenceKind).toBe("pattern");
    expect(chart.reference).toEqual([
      { at: monday, remainingPercent: 100 },
      { at: monday + 5 * DAY, remainingPercent: 0 },
      { at: reset, remainingPercent: 0 },
    ]);
  });

  it("weighs a busy day for more than a quiet one", () => {
    const chart = chartOf({ 1: 300, 2: 100, 3: 100, 4: 100, 5: 100, 6: 0, 7: 0 });
    expect(chart.reference.map((point) => [point.at, Math.round(point.remainingPercent)])).toEqual([
      [monday, 100],
      [monday + DAY, 57],
      [monday + 5 * DAY, 0],
      [reset, 0],
    ]);
  });

  it("is even spending when there is no pattern, or none for the days that count", () => {
    expect(chartOf(undefined).referenceKind).toBe("even");
    expect(chartOf(null).referenceKind).toBe("even");
    expect(
      chartOf({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 100, 7: 100 }, weekdaysUtc).referenceKind,
    ).toBe("even");
  });

  it("plots the reading in hand where it was taken, however old the clock it is drawn against", () => {
    // A page left open since Monday noon, with a reading from Wednesday noon.
    const chart = burnDownChart({
      window: weekly(40),
      checkedAt: wednesdayNoon,
    })!;
    expect(chart.readings).toEqual([{ at: wednesdayNoon, remainingPercent: 60 }]);
    // On that stale clock a run rate would see 40% in half a day.
    expect(run(40, monday + 12 * HOUR).forecast!.projectedUsedPercent).toBeCloseTo(560);
    expect(run(40, wednesdayNoon).forecast!.projectedUsedPercent).toBeCloseTo(112);
  });
});

describe("dailyBurn", () => {
  const busyWeekdays = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 0, 7: 0 } as const;
  const recorded: LimitInstance = {
    resetsAt: reset,
    from: monday,
    readings: [
      [monday, 0],
      [monday + DAY, 10],
      [monday + 2 * DAY, 25],
      [wednesdayNoon, 30],
    ],
  };
  const days = (options: Partial<Parameters<typeof dailyBurn>[0]> = {}) =>
    dailyBurn({
      window: weekly(30),
      now: wednesdayNoon,
      checkedAt: wednesdayNoon,
      schedule: everyDayUtc,
      instance: recorded,
      ...options,
    })!;

  it("sets what each day used against what the even line allows it", () => {
    const [mon, tue, wed, thu] = days();
    expect(mon).toMatchObject({
      day: "2026-11-02",
      consumedPercent: 10,
      today: false,
      partial: false,
    });
    expect(mon!.budgetPercent).toBeCloseTo(100 / 7);
    expect(tue).toMatchObject({ day: "2026-11-03", consumedPercent: 15 });
    expect(wed).toMatchObject({ day: "2026-11-04", consumedPercent: 5, today: true });
    // The days still to come have a budget and nothing used.
    expect(thu).toMatchObject({ day: "2026-11-05", consumedPercent: null, today: false });
    expect(days()).toHaveLength(7);
  });

  it("follows the usual pattern, with no budget on the days it puts nothing on", () => {
    const week = days({ weights: busyWeekdays });
    expect(week.map((entry) => Math.round(entry.budgetPercent))).toEqual([
      20, 20, 20, 20, 20, 0, 0,
    ]);
    const schedule = days({ schedule: weekdaysUtc });
    expect(schedule.map((entry) => Math.round(entry.budgetPercent))).toEqual([
      20, 20, 20, 20, 20, 0, 0,
    ]);
  });

  it("does not guess at days before the first reading, and marks the day it began in", () => {
    const late: LimitInstance = {
      resetsAt: reset,
      from: monday + 36 * HOUR,
      readings: [
        [monday + 36 * HOUR, 12],
        [wednesdayNoon, 30],
      ],
    };
    const [mon, tue, wed] = days({ instance: late });
    expect(mon!.consumedPercent).toBeNull();
    // 18 points over the 24 hours from Tuesday noon: half of them by midnight.
    expect(tue).toMatchObject({ consumedPercent: expect.closeTo(9, 5), partial: true });
    expect(wed!.consumedPercent).toBeCloseTo(9);
  });

  it("spreads a gap between two readings over the time it covers", () => {
    const gappy: LimitInstance = {
      resetsAt: reset,
      from: monday,
      readings: [
        [monday + 18 * HOUR, 6],
        [monday + 42 * HOUR, 30],
      ],
    };
    const [mon, tue] = days({ instance: gappy, window: weekly(30) });
    // 24 points over 24 hours: 6 of them by midnight, 18 after.
    expect(mon!.consumedPercent).toBeCloseTo(6);
    expect(tue!.consumedPercent).toBeCloseTo(18);
  });

  it("counts use on a day the schedule leaves out against a budget of nothing", () => {
    const weekend = days({
      schedule: weekdaysUtc,
      now: monday + 5.5 * DAY,
      checkedAt: monday + 5.5 * DAY,
      window: weekly(40),
      instance: {
        ...recorded,
        readings: [...recorded.readings, [monday + 5 * DAY, 30], [monday + 5.5 * DAY, 40]],
      },
    });
    expect(weekend[5]).toMatchObject({ day: "2026-11-07", budgetPercent: 0, today: true });
    expect(weekend[5]!.consumedPercent).toBeGreaterThan(0);
  });

  it("starts at a clearing, with the allowance that was left spread over what remained", () => {
    const afterCredit = days({
      baseline: [wednesdayNoon, 10],
      window: weekly(14),
      now: monday + 3.5 * DAY,
      checkedAt: monday + 3.5 * DAY,
      instance: {
        resetsAt: reset,
        from: wednesdayNoon,
        baseline: [wednesdayNoon, 10],
        readings: [
          [wednesdayNoon, 10],
          [monday + 3.5 * DAY, 14],
        ],
      },
    });
    expect(afterCredit[0]).toMatchObject({ day: "2026-11-04" });
    expect(afterCredit).toHaveLength(5);
    // 90 points over the 4.5 days that remained: half a day on Wednesday.
    expect(afterCredit[0]!.budgetPercent).toBeCloseTo(10);
    // 4 points over the day since the credit: half of them by midnight.
    expect(afterCredit[0]!.consumedPercent).toBeCloseTo(2);
  });

  it("is null for a window with no span", () => {
    const { resetsAt: _resetsAt, ...undated } = weekly(10);
    expect(dailyBurn({ window: undated, now: wednesdayNoon, checkedAt: wednesdayNoon })).toBeNull();
  });
});

describe("paceDetailFor", () => {
  const entry = {
    key: "a",
    identity: "codex:me@example.com",
    driver: "codex",
    limits: { checkedAt: new Date(wednesdayNoon).toISOString(), windows: [weekly(10)] },
  } as unknown as LimitAccount;
  const history = {
    "codex:me@example.com|weekly": [
      { resetsAt: reset, from: wednesdayNoon, baseline: [wednesdayNoon, 0] as const, readings: [] },
    ],
  };
  const busy = Array.from({ length: 31 }, (_, offset) => {
    const date = new Date(Date.UTC(2026, 9, 5 + offset));
    return { day: date.toISOString().slice(0, 10), tokens: date.getUTCDay() === 6 ? 0 : 100 };
  });
  const input = { account: entry, window: weekly(10), schedule: everyDayUtc, now: wednesdayNoon };

  it("finds the clearing recorded for this window and the pattern in the provider's tokens", () => {
    const detail = paceDetailFor({ ...input, history, dailyTokens: () => busy });
    expect(detail.baseline).toEqual([wednesdayNoon, 0]);
    expect(detail.weights).toMatchObject({ 1: 100, 6: 0 });
  });

  it("has neither where there is no history or token history, or enough of it", () => {
    expect(paceDetailFor(input)).toEqual({ baseline: undefined, weights: null });
    expect(paceDetailFor({ ...input, dailyTokens: () => undefined }).weights).toBeNull();
    expect(paceDetailFor({ ...input, dailyTokens: () => busy.slice(-5) }).weights).toBeNull();
    const { resetsAt: _resetsAt, ...undated } = weekly(10);
    expect(paceDetailFor({ ...input, window: undated, history }).baseline).toBeUndefined();
  });
});
