import type { ForecastAlgorithm } from "@t3tools/shared/usageLimitForecast";
import {
  DEFAULT_REMINDER_SETTINGS,
  NO_REMINDER_STATE,
  type ReminderSettings,
  type ReminderState,
  normalizeReminderSettings,
} from "@t3tools/shared/usageLimitReminders";
import * as Schema from "effect/Schema";

import {
  dispatchLocalStorageChange,
  getLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "../../hooks/useLocalStorage";

export const FORECAST_ALGORITHM_LABELS: Record<ForecastAlgorithm, string> = {
  runRate: "Run rate",
  weekday: "Weekday pattern",
  trend: "Recent trend",
};

const SETTINGS_KEY = "t3code:usage-limit-reminders:v1";
const STATE_KEY = "t3code:usage-limit-reminders-sent:v1";

// Each field is checked on its own by `normalizeReminderSettings`, so one bad value costs only itself.
const StoredSettingsSchema = Schema.Record(Schema.String, Schema.Unknown);
const ReminderStateSchema = Schema.Struct({
  sent: Schema.Record(Schema.String, Schema.Number),
  digestDay: Schema.Record(Schema.String, Schema.String),
});

export function readReminderSettings(): ReminderSettings {
  try {
    return normalizeReminderSettings(getLocalStorageItem(SETTINGS_KEY, StoredSettingsSchema));
  } catch (error) {
    console.error("Could not read Limits reminder settings.", error);
    return DEFAULT_REMINDER_SETTINGS;
  }
}

/** Applies a change to the settings as they are stored now, so another window's change is kept. */
export function updateReminderSettings(change: Partial<ReminderSettings>): void {
  try {
    setLocalStorageItem(
      SETTINGS_KEY,
      { ...readReminderSettings(), ...change },
      StoredSettingsSchema,
    );
    dispatchLocalStorageChange(SETTINGS_KEY);
  } catch (error) {
    console.error("Could not save Limits reminder settings.", error);
  }
}

export function useReminderSettings() {
  const [stored] = useLocalStorage(SETTINGS_KEY, {}, StoredSettingsSchema);
  return [normalizeReminderSettings(stored), updateReminderSettings] as const;
}

export function readReminderState(): ReminderState {
  try {
    return getLocalStorageItem(STATE_KEY, ReminderStateSchema) ?? NO_REMINDER_STATE;
  } catch (error) {
    console.error("Could not read Limits reminder history.", error);
    return NO_REMINDER_STATE;
  }
}

/** Stores a new state. A failed write only risks a repeated reminder, never a lost one. */
export function writeReminderState(state: ReminderState): void {
  try {
    setLocalStorageItem(STATE_KEY, state, ReminderStateSchema);
  } catch (error) {
    console.error("Could not save Limits reminder history.", error);
  }
}

export const USAGE_LIMIT_REMINDER_SETTINGS_KEY = SETTINGS_KEY;
