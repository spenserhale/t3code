import { NO_LIMIT_GROUPS, type LimitGroupState } from "@t3tools/shared/usageLimitGroups";
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
});

export function readUsageLimitGroups(): LimitGroupState {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsageLimitGroupsSchema) ?? NO_LIMIT_GROUPS;
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
  return [groups, updateUsageLimitGroups] as const;
}
