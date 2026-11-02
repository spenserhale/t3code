import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../../hooks/useLocalStorage";
import { extractIssueKeys, issueProjectKey, unusedBranchName } from "./jiraIssueKeys";

/**
 * Threads started from an issue, kept on this device until their title has been
 * set. A draft only gets a title when its first message is sent, and the title
 * the server then writes is its own summary of the message, which seldom names
 * the issue. The thread's own id is the same before and after that message.
 */
const JiraThreadStart = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  issueKey: Schema.String,
  /** `KEY: summary`, the title the thread should end up with. */
  title: Schema.String,
  /** The branch for the thread's new worktree, when it was asked to have one. */
  branch: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
});
export type JiraThreadStart = typeof JiraThreadStart.Type;

const STORAGE_KEY = "t3code:jira:thread-starts:v1";
const StartsSchema = Schema.Array(JiraThreadStart);
const NO_STARTS: ReadonlyArray<JiraThreadStart> = [];
const KEEP_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STARTS = 50;

const recent = (starts: ReadonlyArray<JiraThreadStart>, now: number) =>
  starts.filter((start) => now - start.startedAt < KEEP_FOR_MS).slice(-MAX_STARTS);

export function registerJiraThreadStart(input: Omit<JiraThreadStart, "startedAt">): void {
  const start = { ...input, startedAt: Date.now() };
  writeLocalStorageValue(
    STORAGE_KEY,
    (current: ReadonlyArray<JiraThreadStart>) => [
      ...recent(current, start.startedAt).filter((entry) => entry.threadId !== start.threadId),
      start,
    ],
    NO_STARTS,
    StartsSchema,
  );
}

export function forgetJiraThreadStart(threadId: ThreadId): void {
  writeLocalStorageValue(
    STORAGE_KEY,
    (current: ReadonlyArray<JiraThreadStart>) =>
      current.filter((entry) => entry.threadId !== threadId),
    NO_STARTS,
    StartsSchema,
  );
}

export function useJiraThreadStarts(): ReadonlyArray<JiraThreadStart> {
  return useLocalStorage(STORAGE_KEY, NO_STARTS, StartsSchema)[0];
}

/**
 * The branch to give the worktree a draft is about to create, as the composer's
 * `prepareWorktree` takes it. Nothing for a thread that was not started from an issue.
 */
export function jiraWorktreeBranchFor(threadId: ThreadId): { readonly branch?: string } {
  const start = readLocalStorageValue(STORAGE_KEY, NO_STARTS, StartsSchema).find(
    (entry) => entry.threadId === threadId,
  );
  return start?.branch ? { branch: start.branch } : {};
}

/**
 * What to do about a started thread now: wait for its first message and the
 * title made from it, give it the title, or stop watching because there is
 * nothing left to do.
 */
export function nextStepForThreadStart(
  shell: {
    readonly title: string;
    readonly titleRegeneration?: unknown;
    readonly latestUserMessageAt: string | null;
    readonly deletedAt: string | null;
  } | null,
  start: JiraThreadStart,
): "wait" | "rename" | "done" {
  if (shell === null) return "wait";
  if (shell.deletedAt !== null) return "done";
  // The thread can exist a moment before its first message, whose title would replace this one.
  if (shell.latestUserMessageAt === null || shell.titleRegeneration != null) return "wait";
  const project = new Set([issueProjectKey(start.issueKey)]);
  const named = extractIssueKeys({ title: shell.title, branch: null }, project);
  return named.includes(start.issueKey) ? "done" : "rename";
}

type ThreadStartPlan =
  | { readonly ready: true; readonly worktree: boolean }
  | { readonly ready: false; readonly reason: "checking" | "unknown" };

/**
 * A new worktree whenever the project is a Git repository, unless turned off: its branch carries
 * the issue key where a title refresh cannot drop it. There is no plan until the repository check
 * answers, so a start never falls back to no worktree unchosen; when it fails, the person chooses.
 */
export function threadStartPlan(input: {
  readonly isRepository: boolean | null;
  readonly detectionFailed: boolean;
  readonly choice: boolean | null;
}): ThreadStartPlan {
  if (input.isRepository === true) return { ready: true, worktree: input.choice ?? true };
  if (input.isRepository === false || input.choice === false) {
    return { ready: true, worktree: false };
  }
  return { ready: false, reason: input.detectionFailed ? "unknown" : "checking" };
}

/** How an attempt to give a thread its title ended. */
export function renameOutcome(
  result:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
): "renamed" | "refused" | "failed" {
  if (result._tag === "Success") return "renamed";
  const error = Cause.squash(result.cause);
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentAuthorizationError"
    ? "refused"
    : "failed";
}

const RENAME_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

type RenameFollowUp = "forget" | "keep" | { readonly retryInMs: number };

/**
 * What to do with a start after trying to give its thread the title. A rename that went through
 * has nothing left to do, and neither has one the connection is not allowed to make. Any other
 * failure may pass, so the start is kept and tried again, a few times with growing waits and
 * then once more the next time the app starts.
 */
export function followUpToRename(
  outcome: "renamed" | "refused" | "failed",
  failures: number,
): RenameFollowUp {
  if (outcome !== "failed") return "forget";
  const retryInMs = RENAME_RETRY_DELAYS_MS[failures - 1];
  return retryInMs === undefined ? "keep" : { retryInMs };
}

/** The registered branch for the first thread, and the next free numbered name for each other. */
export function fanoutBranches(
  base: string,
  count: number,
  takenElsewhere: ReadonlySet<string>,
): ReadonlyArray<string> {
  const used = new Set(takenElsewhere).add(base);
  const branches = [base];
  for (let index = 1; index < count; index += 1) {
    const next = unusedBranchName(base, used);
    used.add(next);
    branches.push(next);
  }
  return branches;
}

/** Branches the unsent starts on this device have already claimed. */
export function pendingStartBranches(): ReadonlySet<string> {
  return new Set(
    readLocalStorageValue(STORAGE_KEY, NO_STARTS, StartsSchema).flatMap((entry) =>
      entry.branch === null ? [] : [entry.branch],
    ),
  );
}

interface JiraFanout {
  /** Registers child `index` for its title and returns the worktree branch it should get. */
  readonly adopt: (index: number, childThreadId: ThreadId) => { readonly branch?: string };
  /** Drops the draft's own registration, once every child has started. */
  readonly finish: () => void;
}

const NO_FANOUT: JiraFanout = { adopt: () => ({}), finish: () => {} };

/**
 * A send to several models starts one new thread per model, so the draft's registration cannot
 * follow any of them. Each child is registered for the same title, and when the draft was to have
 * a worktree each gets a branch of its own: the registered one first, then numbered ones.
 */
export function planJiraFanout(parentThreadId: ThreadId, count: number): JiraFanout {
  const starts = readLocalStorageValue(STORAGE_KEY, NO_STARTS, StartsSchema);
  const parent = starts.find((entry) => entry.threadId === parentThreadId);
  if (parent === undefined) return NO_FANOUT;
  const branches =
    parent.branch === null
      ? null
      : fanoutBranches(
          parent.branch,
          count,
          new Set(
            starts.flatMap((entry) =>
              entry.threadId === parentThreadId || entry.branch === null ? [] : [entry.branch],
            ),
          ),
        );
  return {
    adopt: (index, childThreadId) => {
      const branch = branches?.[index] ?? null;
      registerJiraThreadStart({
        environmentId: parent.environmentId,
        threadId: childThreadId,
        issueKey: parent.issueKey,
        title: parent.title,
        branch,
      });
      return branch === null ? {} : { branch };
    },
    finish: () => forgetJiraThreadStart(parentThreadId),
  };
}
