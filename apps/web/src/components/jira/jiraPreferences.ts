import { EnvironmentId, ProjectId, type JiraTransition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/** Kept on this device only; Jira itself has no say in how a person starts work. */
const JiraPreferences = Schema.Struct({
  /** The project a thread started from an issue of each Jira project last went to. */
  projects: Schema.Record(
    Schema.String,
    Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId }),
  ),
  /** Whether a new thread gets its own worktree and branch. */
  newWorktree: Schema.Boolean,
  /** The status to move an issue to when a thread starts from it; `null` leaves it alone. */
  moveOnStart: Schema.NullOr(Schema.String),
});
export type JiraPreferences = typeof JiraPreferences.Type;

const STORAGE_KEY = "t3code:jira:preferences:v1";
const DEFAULT_PREFERENCES: JiraPreferences = {
  projects: {},
  newWorktree: false,
  moveOnStart: null,
};

export function useJiraPreferences(): readonly [
  JiraPreferences,
  (patch: Partial<JiraPreferences>) => void,
] {
  const [preferences, setPreferences] = useLocalStorage(
    STORAGE_KEY,
    DEFAULT_PREFERENCES,
    JiraPreferences,
  );
  return [preferences, (patch) => setPreferences((current) => ({ ...current, ...patch }))];
}

/** The transition that lands on the wanted status, which is matched by name and not by case. */
export function transitionToStatus(
  transitions: ReadonlyArray<JiraTransition>,
  status: string,
): JiraTransition | null {
  const wanted = status.trim().toLowerCase();
  if (wanted.length === 0) return null;
  return (
    transitions.find((transition) => transition.to.name.toLowerCase() === wanted) ??
    transitions.find((transition) => transition.name.toLowerCase() === wanted) ??
    null
  );
}
