import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../../hooks/useLocalStorage";
import { extractIssueKeys, issueProjectKey } from "./jiraIssueKeys";

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

/**
 * Whether a thread started from an issue gets its own worktree: whenever the project is known to
 * be a Git repository, unless the person turned it off. The branch then carries the issue key,
 * which an automatic title refresh cannot drop.
 */
export function startsInWorktree(input: {
  readonly isRepository: boolean | null;
  readonly choice: boolean | null;
}): boolean {
  return input.isRepository === true && (input.choice ?? true);
}
