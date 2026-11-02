import type {
  EnvironmentId,
  ModelSelection,
  ScopedProjectRef,
  ServerProvider,
  VcsStatusResult,
} from "@t3tools/contracts";
import { resolveAutoFeatureBranchName, sanitizeBranchFragment } from "@t3tools/shared/git";
import { resolveSelectableModel } from "@t3tools/shared/model";

import { scopeProjectRef } from "./environment/scoped.ts";
import type { EnvironmentProject, ThreadRuntimeSummary } from "./state/models.ts";
import { buildProjectGroups, type ProjectGroupingSettings } from "./state/projectGrouping.ts";

export interface HandoffThread {
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runStatus: ThreadRuntimeSummary["status"] | null;
  /** An approval waits for an answer; settling the thread would be refused until it has one. */
  readonly hasPendingApproval: boolean;
}

export interface HandoffEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** Can create and send threads there. */
  readonly canOperate: boolean;
  /** Can clone a project it does not have yet. */
  readonly canAddProject: boolean;
  readonly scratchAvailable: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The largest file it takes as an attachment; null when it takes none. */
  readonly maxFileBytes: number | null;
}

export type HandoffMachineStatus =
  | {
      readonly kind: "ready";
      /** The machine's checkout of the project, or null for its project-less folder. */
      readonly project: EnvironmentProject | null;
    }
  | { readonly kind: "needs-project"; readonly canAdd: boolean }
  | { readonly kind: "unavailable"; readonly reason: "offline" | "read-only" | "no-folder" };

export interface HandoffMachine {
  readonly environment: HandoffEnvironment;
  readonly status: HandoffMachineStatus;
}

export type HandoffGitStatus = Pick<
  VcsStatusResult,
  | "isRepo"
  | "hasPrimaryRemote"
  | "refName"
  | "isDefaultRef"
  | "hasWorkingTreeChanges"
  | "hasUpstream"
  | "aheadCount"
> & { readonly workingTree: { readonly files: ReadonlyArray<unknown> } };

export type HandoffNoCodeReason = "scratch" | "no-remote" | "not-a-repo" | "nothing-to-carry";

export type HandoffCodePlan =
  | { readonly kind: "none"; readonly reason: HandoffNoCodeReason }
  | {
      readonly kind: "carry";
      /** The branch that holds the work once the steps below have run. */
      readonly branch: string;
      readonly createBranch: boolean;
      readonly commit: { readonly fileCount: number; readonly message: string } | null;
    };

export type HandoffBlockReason =
  | "thread-running"
  | "thread-waiting"
  | "machine-offline"
  | "machine-read-only"
  | "no-folder"
  | "needs-project"
  | "git-loading"
  | "detached-head";

export interface HandoffBlocked {
  readonly kind: "blocked";
  readonly reason: HandoffBlockReason;
  readonly message: string;
}

export interface HandoffReady {
  readonly kind: "ready";
  readonly code: HandoffCodePlan;
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    /** Null opens the machine's project-less folder. */
    readonly project: ScopedProjectRef | null;
    /** What the machine calls the remote the work is pushed to. */
    readonly remoteName: string;
  };
  readonly transcript: { readonly attach: boolean; readonly maxBytes: number | null };
  /** Null leaves the draft on the machine's own default. */
  readonly modelSelection: ModelSelection | null;
}

export type ThreadMachineHandoffPlan = HandoffBlocked | HandoffReady;

export type HandoffStep = "conversation" | "branch" | "commit" | "push" | "draft";

/** The statuses the app counts as working; settling refuses all of them. */
const BUSY_RUN_STATUSES = new Set<HandoffThread["runStatus"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** The remote a project's grouping follows: a fork's own `origin`, else the one it locates by. */
function remoteNameOf(project: EnvironmentProject | null): string {
  const identity = project?.repositoryIdentity;
  if (identity == null || identity.origin !== undefined) return "origin";
  return identity.locator.remoteName;
}

/** Whether work in the project can travel through its git remote. */
export function carriesHandoffCode(project: EnvironmentProject): boolean {
  return project.isScratch !== true && Boolean(project.repositoryIdentity?.locator.remoteUrl);
}

/** One entry for every machine but the source's, saying whether the thread can go there. */
export function assessHandoffMachines(input: {
  readonly source: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly settings: ProjectGroupingSettings;
  readonly environments: ReadonlyArray<HandoffEnvironment>;
}): ReadonlyArray<HandoffMachine> {
  const carriesCode = carriesHandoffCode(input.source);
  // The machines' checkouts of the same repository are the source's project group.
  const siblings = carriesCode
    ? (buildProjectGroups({ projects: input.projects, settings: input.settings })
        .find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === input.source.environmentId && ref.projectId === input.source.id,
          ),
        )
        ?.memberProjectRefs.flatMap((ref) => {
          const project = input.projects.find(
            (candidate) =>
              candidate.environmentId === ref.environmentId && candidate.id === ref.projectId,
          );
          return project === undefined || project.archivedAt != null ? [] : [project];
        }) ?? [])
    : [];
  return input.environments
    .filter((environment) => environment.environmentId !== input.source.environmentId)
    .map((environment): HandoffMachine => {
      if (!environment.connected) {
        return { environment, status: { kind: "unavailable", reason: "offline" } };
      }
      if (!environment.canOperate) {
        return { environment, status: { kind: "unavailable", reason: "read-only" } };
      }
      if (!carriesCode) {
        return environment.scratchAvailable
          ? { environment, status: { kind: "ready", project: null } }
          : { environment, status: { kind: "unavailable", reason: "no-folder" } };
      }
      const project = siblings.find(
        (sibling) => sibling.environmentId === environment.environmentId,
      );
      return {
        environment,
        status:
          project === undefined
            ? { kind: "needs-project", canAdd: environment.canAddProject }
            : { kind: "ready", project },
      };
    });
}

/** Keeps the model and its options when the machine has that provider and model. */
export function resolveHandoffModelSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (
    provider === undefined ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status === "error"
  ) {
    return null;
  }
  const model = resolveSelectableModel(provider.driver, selection.model, provider.models);
  return model === null ? null : { ...selection, model };
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
 * The server only knows the default branch from `origin/HEAD`, so main and master count whatever
 * it says: a WIP commit never goes to either.
 */
export function isHandoffDefaultBranch(
  git: Pick<HandoffGitStatus, "isDefaultRef" | "refName">,
): boolean {
  return git.isDefaultRef || git.refName === "main" || git.refName === "master";
}

function planCode(input: {
  readonly thread: HandoffThread;
  readonly machineLabel: string;
  readonly git: HandoffGitStatus;
  readonly existingBranchNames: ReadonlyArray<string>;
}): { readonly code: HandoffCodePlan } | HandoffBlocked {
  const { git } = input;
  const none = (reason: HandoffNoCodeReason) => ({ code: { kind: "none", reason } }) as const;
  if (!git.isRepo) return none("not-a-repo");
  if (!git.hasPrimaryRemote) return none("no-remote");
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
      }
    : null;
  if (isHandoffDefaultBranch(git)) {
    if (!hasLocalWork) return none("nothing-to-carry");
    return {
      code: {
        kind: "carry",
        branch: pickHandoffBranchName(input.thread.title, input.existingBranchNames),
        createBranch: true,
        commit,
      },
    };
  }
  if (!hasLocalWork && !git.hasUpstream) return none("nothing-to-carry");
  return { code: { kind: "carry", branch: git.refName, createBranch: false, commit } };
}

/** What continuing the thread on a machine takes, or why it cannot be done yet. */
export function planThreadMachineHandoff(input: {
  readonly thread: HandoffThread;
  readonly source: EnvironmentProject;
  readonly machine: HandoffMachine;
  /** Null while the checkout's status is still loading. */
  readonly git: HandoffGitStatus | null;
  readonly existingBranchNames: ReadonlyArray<string>;
}): ThreadMachineHandoffPlan {
  const { thread, machine } = input;
  const { environment, status } = machine;
  if (BUSY_RUN_STATUSES.has(thread.runStatus)) {
    return {
      kind: "blocked",
      reason: "thread-running",
      message: "This thread is still working. Wait for it to finish or stop it first.",
    };
  }
  if (thread.hasPendingApproval) {
    return {
      kind: "blocked",
      reason: "thread-waiting",
      message: "This thread is waiting on an approval. Answer it first.",
    };
  }
  if (status.kind === "unavailable") {
    switch (status.reason) {
      case "offline":
        return {
          kind: "blocked",
          reason: "machine-offline",
          message: `${environment.label} is not connected.`,
        };
      case "read-only":
        return {
          kind: "blocked",
          reason: "machine-read-only",
          message: `This connection cannot start threads on ${environment.label}.`,
        };
      case "no-folder":
        return {
          kind: "blocked",
          reason: "no-folder",
          message: `${environment.label} has no folder for threads without a project.`,
        };
    }
  }
  if (status.kind === "needs-project") {
    return {
      kind: "blocked",
      reason: "needs-project",
      message: `${environment.label} does not have this project yet.`,
    };
  }
  const targetProject = status.project;
  const target = {
    environmentId: environment.environmentId,
    label: environment.label,
    project:
      targetProject === null
        ? null
        : scopeProjectRef(targetProject.environmentId, targetProject.id),
    remoteName: remoteNameOf(targetProject),
  };
  const common = {
    kind: "ready",
    target,
    transcript: {
      attach: environment.maxFileBytes !== null,
      maxBytes: environment.maxFileBytes,
    },
    modelSelection: resolveHandoffModelSelection(thread.modelSelection, environment.providers),
  } as const;
  if (!carriesHandoffCode(input.source) || targetProject === null) {
    const reason = input.source.isScratch === true ? "scratch" : "no-remote";
    return { ...common, code: { kind: "none", reason } };
  }
  if (input.git === null) {
    return { kind: "blocked", reason: "git-loading", message: "Checking the repository…" };
  }
  const planned = planCode({
    thread,
    machineLabel: environment.label,
    git: input.git,
    existingBranchNames: input.existingBranchNames,
  });
  return "kind" in planned ? planned : { ...common, code: planned.code };
}

/** The steps a ready plan runs, in order. */
export function listHandoffSteps(plan: HandoffReady): ReadonlyArray<HandoffStep> {
  const { code } = plan;
  return [
    ...(plan.transcript.attach ? (["conversation"] as const) : []),
    ...(code.kind === "carry"
      ? [
          ...(code.createBranch ? (["branch"] as const) : []),
          ...(code.commit === null ? [] : (["commit"] as const)),
          "push" as const,
        ]
      : []),
    "draft" as const,
  ];
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

/** The base branch for the machine's worktree, from where the work was pushed. */
export function resolveHandoffDraftBase(
  plan: HandoffReady,
  pushedUpstreamBranch: string | undefined,
): string | null {
  if (plan.code.kind !== "carry" || pushedUpstreamBranch === undefined) return null;
  const separator = pushedUpstreamBranch.indexOf("/");
  const branch = separator < 0 ? pushedUpstreamBranch : pushedUpstreamBranch.slice(separator + 1);
  return branch.length === 0 ? null : `${plan.target.remoteName}/${branch}`;
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
  /** Where the work landed, when it did. */
  readonly pushedBase: string | null;
  readonly threadLink: string | null;
  readonly transcriptAttached: boolean;
}): string {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled thread";
  const lines = [`Continuing "${title}", handed off from ${input.sourceLabel}.`, ""];
  if (input.code.kind === "carry" && input.pushedBase !== null) {
    const wip =
      input.code.commit === null ? "" : ", which includes a WIP commit of the uncommitted changes";
    lines.push(`- The worktree starts from \`${input.pushedBase}\`${wip}.`);
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
