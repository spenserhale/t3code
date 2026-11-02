import type {
  EnvironmentId,
  ModelSelection,
  RepositoryIdentity,
  ScopedProjectRef,
  ServerProvider,
  VcsStatusResult,
} from "@t3tools/contracts";
import { resolveAutoFeatureBranchName, sanitizeBranchFragment } from "@t3tools/shared/git";
import { resolveSelectableModel } from "@t3tools/shared/model";

import { scopeProjectRef } from "./environment/scoped.ts";
import type { EnvironmentProject, ThreadRuntimeSummary } from "./state/models.ts";
import { deriveRepositoryRelativeProjectPath } from "./state/projectGrouping.ts";

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
  /** Can make worktrees and fetch there. */
  readonly canSourceControl: boolean;
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
  /** Several checkouts fit; the user says which one the thread continues in. */
  | { readonly kind: "choose"; readonly projects: ReadonlyArray<EnvironmentProject> }
  | { readonly kind: "needs-project"; readonly canAdd: boolean }
  | { readonly kind: "unavailable"; readonly reason: "offline" | "read-only" | "no-folder" };

export interface HandoffMachine {
  readonly environment: HandoffEnvironment;
  readonly status: HandoffMachineStatus;
}

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

/** What the connection may do on the source's machine. */
export interface HandoffSourceAccess {
  /** Change threads there: move their branch, settle them. */
  readonly canOperate: boolean;
  /** Commit and push there. */
  readonly canSourceControl: boolean;
}

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

export interface HandoffReady {
  readonly kind: "ready";
  readonly code: HandoffCodePlan;
  /** The source's repository, to tell which of its remotes the work was pushed to. */
  readonly sourceIdentity: RepositoryIdentity | null;
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    /** Null opens the machine's project-less folder. */
    readonly project: ScopedProjectRef | null;
    /** The project's folder on that machine, where git runs. */
    readonly cwd: string | null;
    readonly identity: RepositoryIdentity | null;
  };
  readonly transcript: { readonly attach: boolean; readonly maxBytes: number | null };
  /** Null leaves the draft on the machine's own default. */
  readonly modelSelection: ModelSelection | null;
}

export type ThreadMachineHandoffPlan = HandoffBlocked | HandoffReady;

export type HandoffStep =
  | "conversation"
  | "branch"
  | "commit"
  | "push"
  | "fetch"
  | "worktree"
  | "draft";

/** The statuses the app counts as working; settling refuses all of them. */
const BUSY_RUN_STATUSES = new Set<HandoffThread["runStatus"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Whether work in the project can travel through its git remote. */
export function carriesHandoffCode(project: EnvironmentProject): boolean {
  return project.isScratch !== true && Boolean(project.repositoryIdentity?.locator.remoteUrl);
}

/** The repository a push from the project goes to: a fork's own origin, else its only remote. */
function pushedRepositoryKey(identity: RepositoryIdentity): string {
  return identity.origin?.canonicalKey ?? identity.canonicalKey;
}

/** The repository one of the project's remotes points to, when the identity says. */
function repositoryKeyOfRemote(identity: RepositoryIdentity, remoteName: string): string | null {
  if (remoteName === "origin") return pushedRepositoryKey(identity);
  return remoteName === identity.locator.remoteName ? identity.canonicalKey : null;
}

/** The project's name for its remote of that repository. */
function remoteNameOfRepository(identity: RepositoryIdentity, key: string): string | null {
  if (identity.origin?.canonicalKey === key) return "origin";
  return identity.canonicalKey === key ? identity.locator.remoteName : null;
}

function isCheckoutOf(project: EnvironmentProject, key: string): boolean {
  const identity = project.repositoryIdentity;
  return (
    identity != null && (identity.canonicalKey === key || identity.origin?.canonicalKey === key)
  );
}

/**
 * The machine's checkouts of the source's repository, in the source's place in it. This follows
 * the repository itself, so the sidebar's grouping can neither hide a checkout nor merge another
 * project of the same repository into it.
 */
function findCheckouts(
  source: EnvironmentProject,
  environmentId: EnvironmentId,
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<EnvironmentProject> {
  const key = source.repositoryIdentity ? pushedRepositoryKey(source.repositoryIdentity) : null;
  if (key === null) return [];
  const sourcePath = deriveRepositoryRelativeProjectPath(source);
  return projects.filter((project) => {
    if (
      project.environmentId !== environmentId ||
      project.archivedAt != null ||
      project.isScratch === true ||
      !isCheckoutOf(project, key)
    ) {
      return false;
    }
    const path = deriveRepositoryRelativeProjectPath(project);
    // A path that cannot be worked out on either side can still be the one project there is.
    return sourcePath === null || path === null || path === sourcePath;
  });
}

/** One entry for every machine but the source's, saying whether the thread can go there. */
export function assessHandoffMachines(input: {
  readonly source: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environments: ReadonlyArray<HandoffEnvironment>;
}): ReadonlyArray<HandoffMachine> {
  const carriesCode = carriesHandoffCode(input.source);
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
      const [first, ...others] = findCheckouts(
        input.source,
        environment.environmentId,
        input.projects,
      );
      return {
        environment,
        status:
          first === undefined
            ? { kind: "needs-project", canAdd: environment.canAddProject }
            : others.length === 0
              ? { kind: "ready", project: first }
              : { kind: "choose", projects: [first, ...others] },
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

function planCode(input: {
  readonly thread: HandoffThread;
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
        branch: pickHandoffBranchName(input.thread.title, input.existingBranchNames),
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

/** Whether two plans do the same to the checkout, so one made earlier still holds. */
export function isSameHandoffCode(planned: HandoffCodePlan, fresh: HandoffCodePlan): boolean {
  if (planned.kind === "none" || fresh.kind === "none") {
    return planned.kind === "none" && fresh.kind === "none" && planned.reason === fresh.reason;
  }
  return (
    planned.branch === fresh.branch &&
    planned.createBranch === fresh.createBranch &&
    (planned.commit === null) === (fresh.commit === null) &&
    // Changes the user did not see listed are not changes they agreed to push.
    (planned.commit?.paths.join("\0") ?? "") === (fresh.commit?.paths.join("\0") ?? "")
  );
}

/** What continuing the thread on a machine takes, or why it cannot be done yet. */
export function planThreadMachineHandoff(input: {
  readonly thread: HandoffThread;
  readonly source: EnvironmentProject;
  readonly sourceAccess: HandoffSourceAccess;
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
  if (!input.sourceAccess.canOperate) {
    return {
      kind: "blocked",
      reason: "source-read-only",
      message: "This connection cannot change this thread, so it cannot hand it off.",
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
  if (status.kind === "choose") {
    return {
      kind: "blocked",
      reason: "choose-project",
      message: `${environment.label} has more than one checkout of this project. Choose the one to continue in.`,
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
    cwd: targetProject?.workspaceRoot ?? null,
    identity: targetProject?.repositoryIdentity ?? null,
  };
  const common = {
    kind: "ready",
    sourceIdentity: input.source.repositoryIdentity ?? null,
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
  if ("kind" in planned) return planned;
  if (planned.code.kind === "carry" && !input.sourceAccess.canSourceControl) {
    return {
      kind: "blocked",
      reason: "source-no-source-control",
      message: "This connection cannot commit or push on the source machine.",
    };
  }
  if (planned.code.kind === "carry" && !environment.canSourceControl) {
    return {
      kind: "blocked",
      reason: "machine-no-source-control",
      message: `This connection cannot create worktrees on ${environment.label}.`,
    };
  }
  return { ...common, code: planned.code };
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
          "fetch" as const,
          "worktree" as const,
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

export type HandoffPushed =
  | {
      readonly ok: true;
      /** The branch on the remote, which the worktree continues under the same name. */
      readonly branch: string;
      /** What the source calls the remote the work went to, and the target machine calls it. */
      readonly sourceRemote: string;
      readonly remote: string;
      readonly remoteRef: string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Where the push put the work, in the target machine's terms. The remote the source pushed to has
 * to be a repository the target has a remote for, or the target would be told to fetch from
 * somewhere the branch is not.
 */
export function resolveHandoffPushed(
  plan: HandoffReady,
  upstreamBranch: string | undefined,
): HandoffPushed {
  const refuse = (message: string) => ({ ok: false, message }) as const;
  if (plan.code.kind !== "carry") return refuse("No code was planned to hand off.");
  if (upstreamBranch === undefined) {
    return refuse("The push did not say which remote branch it updated.");
  }
  const known = [plan.sourceIdentity?.locator.remoteName, "origin"]
    .filter((name): name is string => name !== undefined)
    .sort((left, right) => right.length - left.length);
  const sourceRemote =
    known.find((name) => upstreamBranch.startsWith(`${name}/`)) ??
    upstreamBranch.slice(0, Math.max(upstreamBranch.indexOf("/"), 0));
  const branch = upstreamBranch.slice(sourceRemote.length + 1);
  if (sourceRemote.length === 0 || branch.length === 0) {
    return refuse(`The push reported the remote branch "${upstreamBranch}", which is not usable.`);
  }
  const key =
    plan.sourceIdentity === null ? null : repositoryKeyOfRemote(plan.sourceIdentity, sourceRemote);
  if (key === null) {
    return refuse(
      `The work was pushed to the remote "${sourceRemote}", which cannot be matched to a remote on ${plan.target.label}.`,
    );
  }
  const remote =
    plan.target.identity === null ? null : remoteNameOfRepository(plan.target.identity, key);
  if (remote === null) {
    return refuse(
      `${plan.target.label} has no remote for ${key}, where the work was pushed to ("${sourceRemote}").`,
    );
  }
  return { ok: true, branch, sourceRemote, remote, remoteRef: `${remote}/${branch}` };
}

/** The branch the work is compared with, under the target machine's name for its remote. */
export function resolveHandoffComparisonBase(
  base: string | null,
  pushed: Extract<HandoffPushed, { ok: true }>,
): string | null {
  if (base === null) return null;
  return base.startsWith(`${pushed.sourceRemote}/`)
    ? `${pushed.remote}/${base.slice(pushed.sourceRemote.length + 1)}`
    : base;
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
