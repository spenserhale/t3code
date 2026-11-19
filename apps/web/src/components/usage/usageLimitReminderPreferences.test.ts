import { DEFAULT_REMINDER_SETTINGS, NO_REMINDER_STATE } from "@t3tools/shared/usageLimitReminders";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readReminderSettings,
  readReminderState,
  updateReminderSettings,
  writeReminderState,
} from "./usageLimitReminderPreferences";

const settingsKey = "t3code:usage-limit-reminders:v1";
const stateKey = "t3code:usage-limit-reminders-sent:v1";
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => {
        values.set(name, value);
      },
    },
    dispatchEvent: vi.fn(),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reminder settings", () => {
  it("start with a reminder for each window as it qualifies, sessions left out", () => {
    expect(readReminderSettings()).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(DEFAULT_REMINDER_SETTINGS).toMatchObject({
      mode: "perWindow",
      thresholdPercent: 25,
      includeSession: false,
    });
  });

  it("change one field at a time, keeping the others and any change made elsewhere", () => {
    updateReminderSettings({ mode: "digest" });
    const elsewhere = JSON.parse(values.get(settingsKey)!);
    values.set(settingsKey, JSON.stringify({ ...elsewhere, thresholdPercent: 40 }));
    updateReminderSettings({ includeSession: true });
    expect(readReminderSettings()).toEqual({
      ...DEFAULT_REMINDER_SETTINGS,
      mode: "digest",
      thresholdPercent: 40,
      includeSession: true,
    });
  });

  it("lose only the field that is wrong", () => {
    values.set(
      settingsKey,
      JSON.stringify({ mode: "inApp", thresholdPercent: "lots", algorithm: "trend" }),
    );
    expect(readReminderSettings()).toEqual({
      ...DEFAULT_REMINDER_SETTINGS,
      mode: "inApp",
      algorithm: "trend",
    });
    values.set(settingsKey, "not json");
    expect(readReminderSettings()).toEqual(DEFAULT_REMINDER_SETTINGS);
  });
});

describe("what has been reminded", () => {
  it("survives a reload, so a window is not mentioned twice", () => {
    expect(readReminderState()).toEqual(NO_REMINDER_STATE);
    const state = {
      sent: { "claudeAgent:me@example.com|weekly:seven_day|1": 5 },
      digestDay: { other: "2026-11-05" },
    };
    writeReminderState(state);
    expect(readReminderState()).toEqual(state);
  });

  it("forgets state it cannot read rather than failing", () => {
    values.set(stateKey, JSON.stringify({ sent: [1] }));
    expect(readReminderState()).toEqual(NO_REMINDER_STATE);
  });
});
