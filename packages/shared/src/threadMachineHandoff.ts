import type { VcsStatusResult } from "@t3tools/contracts";

import { resolveAutoFeatureBranchName, sanitizeBranchFragment } from "./git.ts";

export type HandoffGitStatus = Pick<
  VcsStatusResult,
  "isRepo" | "refName" | "isDefaultRef" | "hasWorkingTreeChanges" | "hasUpstream" | "aheadCount"
> & {
  readonly workingTree: { readonly files: ReadonlyArray<{ readonly path: string }> };
  /** Whether the repository names its default branch (the remote's HEAD); false guesses by name. */
  readonly defaultBranchKnown: boolean;
  /** What the branch is compared with, which the new worktree keeps for pull requests. */
  readonly branchChanges?: { readonly baseRef: string | null } | undefined;
};

export type HandoffNoCodeReason = "scratch" | "no-remote" | "not-a-repo" | "nothing-to-carry";

export type HandoffCodePlan =
  | { readonly kind: "none"; readonly reason: HandoffNoCodeReason }
  | {
      readonly kind: "carry";
      /** The branch that holds the work once the steps below have run. */
      readonly branch: string;
      readonly createBranch: boolean;
      readonly commit: {
        readonly fileCount: number;
        readonly message: string;
        /** The files the user was shown, sorted: what the plan asks to commit. */
        readonly paths: ReadonlyArray<string>;
      } | null;
      /** What the branch is compared with in pull requests; the new worktree keeps it. */
      readonly comparisonBase: string | null;
    };

export type HandoffBlockReason =
  | "thread-running"
  | "thread-waiting"
  | "source-read-only"
  | "source-no-source-control"
  | "machine-no-source-control"
  | "machine-offline"
  | "machine-read-only"
  | "no-folder"
  | "needs-project"
  | "choose-project"
  | "git-loading"
  | "detached-head";

export interface HandoffBlocked {
  readonly kind: "blocked";
  readonly reason: HandoffBlockReason;
  readonly message: string;
}

/** A branch for the work to travel on, named after the thread and free on this repository. */
export function pickHandoffBranchName(
  title: string,
  existingBranchNames: ReadonlyArray<string>,
): string {
  return resolveAutoFeatureBranchName(
    existingBranchNames,
    `handoff/${sanitizeBranchFragment(title)}`,
  );
}

export function handoffCommitMessage(machineLabel: string): string {
  return `WIP: hand off to ${machineLabel.replace(/\s+/g, " ").trim()}`;
}

/**
 * The server only knows the default branch from `origin/HEAD`. Without it any branch could be the
 * default, so a WIP commit never goes to a branch that might be: main and master by name, and
 * every branch of a repository that does not say.
 */
export function isHandoffDefaultBranch(
  git: Pick<HandoffGitStatus, "isDefaultRef" | "refName" | "defaultBranchKnown">,
): boolean {
  return (
    git.isDefaultRef ||
    !git.defaultBranchKnown ||
    git.refName === "main" ||
    git.refName === "master"
  );
}

/** What names the new branch must not take, as the names refs go by without their remote. */
export const HANDOFF_BRANCH_QUERY = "handoff";

export function collectHandoffBranchNames(
  refs: ReadonlyArray<{
    readonly name: string;
    readonly isRemote?: boolean | undefined;
    readonly remoteName?: string | undefined;
  }>,
): ReadonlyArray<string> {
  return refs.map((ref) =>
    ref.isRemote === true &&
    ref.remoteName !== undefined &&
    ref.name.startsWith(`${ref.remoteName}/`)
      ? ref.name.slice(ref.remoteName.length + 1)
      : ref.name,
  );
}

/** What carrying the checkout's work takes, or why it cannot be done. */
export function planHandoffCode(input: {
  readonly title: string;
  readonly machineLabel: string;
  readonly git: HandoffGitStatus;
  readonly existingBranchNames: ReadonlyArray<string>;
}): { readonly code: HandoffCodePlan } | HandoffBlocked {
  const { git } = input;
  const none = (reason: HandoffNoCodeReason) => ({ code: { kind: "none", reason } }) as const;
  if (!git.isRepo) return none("not-a-repo");
  if (git.refName === null) {
    return {
      kind: "blocked",
      reason: "detached-head",
      message: "This checkout is not on a branch. Switch to a branch to hand the work off.",
    };
  }
  const hasChanges = git.hasWorkingTreeChanges;
  const hasLocalWork = hasChanges || git.aheadCount > 0;
  const commit = hasChanges
    ? {
        fileCount: Math.max(git.workingTree.files.length, 1),
        message: handoffCommitMessage(input.machineLabel),
        paths: git.workingTree.files.map((file) => file.path).sort(),
      }
    : null;
  const comparisonBase = git.branchChanges?.baseRef ?? null;
  if (isHandoffDefaultBranch(git)) {
    if (!hasLocalWork) return none("nothing-to-carry");
    return {
      code: {
        kind: "carry",
        branch: pickHandoffBranchName(input.title, input.existingBranchNames),
        createBranch: true,
        commit,
        comparisonBase,
      },
    };
  }
  if (!hasLocalWork && !git.hasUpstream) return none("nothing-to-carry");
  return {
    code: { kind: "carry", branch: git.refName, createBranch: false, commit, comparisonBase },
  };
}

const GIT_FAILURE_TEXT: Readonly<Record<string, string>> = {
  authentication_failed:
    "Git could not sign in to the remote. Check this machine's credentials for it.",
  host_key_unverified: "Git does not trust the remote's host key yet.",
  push_rejected_non_fast_forward:
    "The remote has commits this branch does not. Pull them, then hand off again.",
  push_rejected_by_remote: "The remote refused the push.",
  remote_unreachable: "Git could not reach the remote. Check the network and try again.",
};

/** The server words git failures in terms of its own commands; this says what to do about them. */
export function explainHandoffGitFailure(message: string): string {
  const reason = /\(([a-z_]+)\)\s*$/.exec(message.trim())?.[1];
  return (reason === undefined ? undefined : GIT_FAILURE_TEXT[reason]) ?? message;
}

const NO_CODE_TEXT = {
  scratch: "this thread has no project",
  "no-remote": "the project has no git remote",
  "not-a-repo": "the project is not a git repository",
  "nothing-to-carry": "the branch has no changes to carry",
} as const satisfies Record<HandoffNoCodeReason, string>;

/** Why only the conversation travels, as the end of a sentence. */
export function explainNoHandoffCode(reason: HandoffNoCodeReason): string {
  return NO_CODE_TEXT[reason];
}

export function buildHandoffNote(input: {
  readonly title: string;
  readonly sourceLabel: string;
  readonly code: HandoffCodePlan;
  /** What the worktree tracks, once the work is there. */
  readonly remoteRef: string | null;
  readonly threadLink: string | null;
  readonly transcriptAttached: boolean;
}): string {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled thread";
  const lines = [`Continuing "${title}", handed off from ${input.sourceLabel}.`, ""];
  if (input.code.kind === "carry" && input.remoteRef !== null) {
    const wip =
      input.code.commit === null ? "" : " and includes a WIP commit of the uncommitted changes";
    lines.push(
      `- The worktree continues \`${input.code.branch}\`, which tracks \`${input.remoteRef}\`${wip}.`,
    );
  } else {
    const reason = explainNoHandoffCode(
      input.code.kind === "none" ? input.code.reason : "nothing-to-carry",
    );
    lines.push(`- No code was carried over: ${reason}.`);
  }
  if (input.threadLink !== null) lines.push(`- Source thread: ${input.threadLink}`);
  lines.push(
    input.transcriptAttached
      ? "- The conversation so far is attached for reference."
      : "- The conversation could not be attached: this machine takes no file attachments.",
  );
  return `${lines.join("\n")}\n\n`;
}
