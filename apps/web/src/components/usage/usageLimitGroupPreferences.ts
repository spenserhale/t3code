import { NO_LIMIT_GROUPS, type LimitGroupState } from "@t3tools/shared/usageLimitGroups";
import { normalizeLimitSchedule, type LimitSchedule } from "@t3tools/shared/usageLimitSchedule";
import * as Schema from "effect/Schema";

import {
  dispatchLocalStorageChange,
  getLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-limit-groups:v1";
const UsageLimitGroupsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  assignments: Schema.Record(Schema.String, Schema.String),
  schedules: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type StoredGroups = typeof UsageLimitGroupsSchema.Type;

/** Keeps the schedules that are still valid; a bad one never costs the assignments beside it. */
function withSchedules(stored: StoredGroups): LimitGroupState {
  const schedules: Record<string, LimitSchedule> = {};
  for (const [key, value] of Object.entries(stored.schedules ?? {})) {
    const schedule = normalizeLimitSchedule(value);
    if (schedule) schedules[key] = schedule;
  }
  const { schedules: _stored, ...rest } = stored;
  return Object.keys(schedules).length > 0 ? { ...rest, schedules } : rest;
}

export function readUsageLimitGroups(): LimitGroupState {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, UsageLimitGroupsSchema);
    return stored === null ? NO_LIMIT_GROUPS : withSchedules(stored);
  } catch (error) {
    console.error("Could not read Limits groups.", error);
    return NO_LIMIT_GROUPS;
  }
}

/**
 * Applies a change to the groups as they are stored now, not as this window
 * last saw them, so a change made in another window is never written over.
 * Invalid stored groups are replaced.
 */
export function updateUsageLimitGroups(change: (groups: LimitGroupState) => LimitGroupState): void {
  try {
    setLocalStorageItem(STORAGE_KEY, change(readUsageLimitGroups()), UsageLimitGroupsSchema);
    dispatchLocalStorageChange(STORAGE_KEY);
  } catch (error) {
    console.error("Could not save Limits groups.", error);
  }
}

/** The saved groups, following changes made in this or any other window. */
export function useUsageLimitGroups() {
  const [groups] = useLocalStorage(STORAGE_KEY, NO_LIMIT_GROUPS, UsageLimitGroupsSchema);
  return [withSchedules(groups), updateUsageLimitGroups] as const;
}
