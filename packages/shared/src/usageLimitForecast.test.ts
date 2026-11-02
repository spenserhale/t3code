// @effect-diagnostics globalDate:off -- Fixtures are built from fixed instants.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type DailyTokens,
  burnDownChart,
  forecastSentence,
  forecastWindow,
  trendRate,
  weekdayWeights,
} from "./usageLimitForecast.ts";
import type { LimitInstance } from "./usageLimitHistory.ts";
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
    // A day with no record is a day of none: four busy Mondays out of five make 80.
    const gaps = busyWeekdays.filter((entry) => entry.day !== "2026-10-19");
    expect(weekdayWeights(gaps, "2026-11-04", [1])![1]).toBeCloseTo(80);
  });

  it("needs two weeks since the first day with use, ignores totals older than 90 days, and use on the counted days", () => {
    expect(weekdayWeights(busyWeekdays, "2026-10-17", [1, 2, 3, 4, 5])).toBeNull();
    expect(weekdayWeights(busyWeekdays, "2026-10-18", [1, 2, 3, 4, 5])).not.toBeNull();
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

  it("draws an ideal line that stands still over the days the schedule leaves out", () => {
    const chart = burnDownChart({
      window: weekly(45),
      now: wednesdayNoon,
      checkedAt: wednesdayNoon,
      schedule: weekdaysUtc,
      instance: recorded,
    })!;
    expect(chart.start).toBe(monday);
    expect(chart.end).toBe(reset);
    expect(chart.ideal).toEqual([
      { at: monday, remainingPercent: 100 },
      { at: monday + 5 * DAY, remainingPercent: 0 },
      { at: reset, remainingPercent: 0 },
    ]);
  });

  it("charts the recorded readings and the one in hand, as what is left", () => {
    const chart = burnDownChart({
      window: weekly(45),
      now: wednesdayNoon,
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
    expect(chart.ideal).toHaveLength(2);
  });

  it("leaves out the readings of an earlier window and still charts the one in hand", () => {
    const chart = burnDownChart({
      window: weekly(5),
      now: wednesdayNoon,
      checkedAt: wednesdayNoon,
      instance: { ...recorded, resetsAt: reset - 7 * DAY },
    })!;
    expect(chart.readings).toEqual([{ at: wednesdayNoon, remainingPercent: 95 }]);
    expect(chart.forecast).toEqual([]);
  });

  it("has nothing to draw for a window with no span", () => {
    const { resetsAt: _resetsAt, ...undated } = weekly(10);
    expect(
      burnDownChart({ window: undated, now: wednesdayNoon, checkedAt: wednesdayNoon }),
    ).toBeNull();
  });
});
