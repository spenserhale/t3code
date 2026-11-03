import {
  OrchestratorMcpFailure,
  type VcsRef,
  type WorktreeOpenBranchInput,
  type WorktreeOpenBranchResult,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { readAllRefPages } from "../git/readAllRefPages.ts";
import { parseRemoteFetchUrls } from "../git/remoteFetchUrls.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { unavailable } from "./threadAccess.ts";

/**
 * Puts a branch that is on a remote into a worktree of a project's repository here, as the
 * target of a thread handed off from another machine. A worktree or local branch that is there
 * already is brought up to the remote, never merged or reset, and left alone if it has work of its
 * own.
 */
export class WorktreeOpenBranch extends Context.Service<
  WorktreeOpenBranch,
  {
    readonly open: (
      scope: McpInvocationScope,
      input: WorktreeOpenBranchInput,
    ) => Effect.Effect<WorktreeOpenBranchResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/WorktreeOpenBranch") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const gitFailed = (what: string) => (error: { readonly message: string }) =>
  failure("orchestration_error", `${what}: ${error.message}`);

/** A branch as a remote names it: without `refs/heads/` or `refs/remotes/`, nor the remote. */
const bareBranchName = (ref: string, remote: string) => {
  const unqualified = ref.replace(/^refs\/(?:heads|remotes)\//, "");
  return unqualified.startsWith(`${remote}/`) ? unqualified.slice(remote.length + 1) : unqualified;
};

const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  // Two calls for one branch run one after the other, so the second finds the first's worktree.
  const branchLocks = yield* KeyedLock.make<string>();

  const removeWorktree = (cwd: string, path: string) =>
    gitWorkflow.removeWorktree({ cwd, path, force: true }).pipe(Effect.ignoreCause({ log: true }));

  const discardNewBranch = (cwd: string, branch: string) =>
    gitWorkflow
      .deleteLocalBranch({ cwd, refName: branch, force: true })
      .pipe(Effect.ignoreCause({ log: true }));

  /** The project's remote that is `repositoryKey`, origin first. */
  const remoteOfRepository = Effect.fn("WorktreeOpenBranch.remoteOfRepository")(function* (
    cwd: string,
    repositoryKey: string,
  ) {
    const listed = yield* git
      .execute({ operation: "WorktreeOpenBranch.listRemotes", cwd, args: ["remote", "-v"] })
      .pipe(Effect.mapError(gitFailed("Could not list the remotes")));
    const fetchUrls = parseRemoteFetchUrls(listed.stdout);
    const names = [...fetchUrls.keys()].toSorted((left, right) =>
      left === "origin" ? -1 : right === "origin" ? 1 : left.localeCompare(right),
    );
    return (
      names.find(
        (name) =>
          sourceControlDefinitions.repositoryKeyFromRemote(fetchUrls.get(name)!) === repositoryKey,
      ) ?? null
    );
  });

  const resolveRemote = Effect.fn("WorktreeOpenBranch.resolveRemote")(function* (
    cwd: string,
    input: WorktreeOpenBranchInput,
  ) {
    if (input.remote === undefined && input.repositoryKey !== undefined) {
      const matched = yield* remoteOfRepository(cwd, input.repositoryKey);
      if (matched === null) {
        return yield* failure(
          "invalid_request",
          `No remote of this project here is ${input.repositoryKey}, so the branch cannot be fetched from where it was pushed. Pass \`remote\` to name one anyway.`,
        );
      }
      return matched;
    }
    const remote = input.remote ?? "origin";
    const exists = yield* gitWorkflow
      .remoteExists({ cwd, remoteName: remote })
      .pipe(Effect.mapError(gitFailed("Could not read the remotes")));
    if (!exists) {
      return yield* failure("invalid_request", `This project has no remote named ${remote}.`);
    }
    return remote;
  });

  /** The commit the branch must hold, found among the worktree's ancestors. */
  const requireCommit = Effect.fn("WorktreeOpenBranch.requireCommit")(function* (
    worktreePath: string,
    commit: string,
    remoteRef: string,
  ) {
    const held = yield* git
      .execute({
        operation: "WorktreeOpenBranch.requireCommit",
        cwd: worktreePath,
        args: ["merge-base", "--is-ancestor", commit, "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.mapError(gitFailed("Could not check the branch for the commit")));
    if (held.exitCode !== 0) {
      return yield* failure(
        "invalid_request",
        `${remoteRef} was fetched here, but it does not hold commit ${commit.slice(0, 7)}. Check that this remote is the repository it was pushed to.`,
      );
    }
  });

  /**
   * Brings a checkout of the branch up to the commit just fetched, only forward. A checkout with
   * changes, commits the remote lacks, or another comparison base than the one asked for is left
   * as it was.
   */
  const catchUp = Effect.fn("WorktreeOpenBranch.catchUp")(function* (
    worktreePath: string,
    target: {
      readonly branch: string;
      readonly remote: string;
      readonly remoteRef: string;
      readonly tip: string;
      readonly baseRef: string | undefined;
    },
  ) {
    const { branch, remote, remoteRef, tip, baseRef } = target;
    const status = yield* git
      .statusDetailsLocal(worktreePath, { includeBranchChanges: true })
      .pipe(Effect.mapError(gitFailed(`Could not read ${branch} in ${worktreePath}`)));
    if (status.hasWorkingTreeChanges) {
      return yield* failure(
        "invalid_request",
        `${branch} is checked out in ${worktreePath}, which has uncommitted changes, so it was left alone. Commit or discard them, then try again.`,
      );
    }
    if (status.aheadCount > 0) {
      return yield* failure(
        "invalid_request",
        `${branch} here has commits that ${remoteRef} does not, so it was left alone.`,
      );
    }
    if (baseRef !== undefined) {
      const actual =
        status.branchChanges?.baseRef == null
          ? null
          : bareBranchName(status.branchChanges.baseRef, remote);
      if (actual !== bareBranchName(baseRef, remote)) {
        return yield* failure(
          "invalid_request",
          `${branch} here compares against ${status.branchChanges?.baseRef ?? "nothing"}, not ${baseRef}, as asked. That cannot be changed from here, so it was left alone.`,
        );
      }
    }
    if (status.behindCount > 0) {
      yield* git
        .execute({
          operation: "WorktreeOpenBranch.fastForward",
          cwd: worktreePath,
          args: ["merge", "--ff-only", tip],
          timeoutMs: 30_000,
        })
        .pipe(Effect.mapError(gitFailed(`${branch} could not be brought up to ${remoteRef}`)));
    }
  });

  /** The base to compare a new branch with, as a ref this repository has. */
  const resolveBase = Effect.fn("WorktreeOpenBranch.resolveBase")(function* (
    cwd: string,
    remote: string,
    baseRef: string,
  ) {
    for (const candidate of [baseRef, `${remote}/${baseRef}`]) {
      const found = yield* git
        .execute({
          operation: "WorktreeOpenBranch.resolveBase",
          cwd,
          args: ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError(gitFailed("Could not read the comparison base")));
      if (found.exitCode === 0) return candidate;
    }
    return yield* failure(
      "invalid_request",
      `This project here does not have ${baseRef}, which the branch is compared with in pull requests.`,
    );
  });

  const openLocked = Effect.fn("WorktreeOpenBranch.openLocked")(function* (
    cwd: string,
    branch: string,
    input: WorktreeOpenBranchInput,
  ) {
    if (!(yield* gitWorkflow.isRepository(cwd).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* failure(
        "invalid_request",
        `Project workspace '${cwd}' is not a git repository.`,
      );
    }
    const remote = yield* resolveRemote(cwd, input);
    const remoteRef = `${remote}/${branch}`;
    const fetched = yield* gitWorkflow
      .fetchWorktreeBaseCommit({ cwd, refName: remoteRef })
      .pipe(Effect.mapError(gitFailed(`Could not fetch ${remoteRef}`)));
    if (fetched === null) {
      return yield* failure(
        "invalid_request",
        `${remote} has no branch ${branch}. Push it first, or check that ${remote} here is the repository it is on.`,
      );
    }
    const target = { branch, remote, remoteRef, tip: fetched.commitSha, baseRef: input.baseRef };
    const refs = yield* readAllRefPages((cursor) =>
      gitWorkflow
        .listRefs({
          cwd,
          query: branch,
          refKind: "local",
          refresh: true,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        })
        .pipe(Effect.mapError(gitFailed("Could not read the branches"))),
    );
    if (refs === null) {
      return yield* failure(
        "orchestration_error",
        "This repository has too many branches to check them all.",
      );
    }
    const local: VcsRef | undefined = refs.find(
      (ref) => ref.isRemote !== true && ref.name === branch,
    );
    const finish = Effect.fn("WorktreeOpenBranch.finish")(function* (
      worktreePath: string,
      created: boolean,
    ) {
      if (input.expectCommit !== undefined) {
        yield* requireCommit(worktreePath, input.expectCommit, remoteRef);
      }
      const head = yield* git
        .resolveCommit({ cwd: worktreePath, revision: "HEAD" })
        .pipe(Effect.mapError(gitFailed("Could not read the branch's commit")));
      return { worktreePath, branch, remote, head: head.commitSha, created };
    });

    if (local !== undefined) {
      if (local.upstreamRef !== `refs/remotes/${remoteRef}`) {
        const tracked = local.upstreamRef?.replace(/^refs\/(?:heads|remotes)\//, "") ?? "nothing";
        return yield* failure(
          "invalid_request",
          `${branch} already exists here and tracks ${tracked}, not ${remoteRef}, so it was left alone.`,
        );
      }
      if (local.worktreePath !== null) {
        yield* catchUp(local.worktreePath, target);
        return yield* finish(local.worktreePath, false);
      }
      const made = yield* gitWorkflow
        .createWorktree({ cwd, refName: branch, path: null })
        .pipe(Effect.mapError(gitFailed(`Could not make a worktree for ${branch}`)));
      const worktreePath = made.worktree.path;
      return yield* catchUp(worktreePath, target).pipe(
        Effect.andThen(finish(worktreePath, true)),
        Effect.onError(() => removeWorktree(cwd, worktreePath)),
      );
    }

    const base =
      input.baseRef === undefined ? undefined : yield* resolveBase(cwd, remote, input.baseRef);
    const made = yield* gitWorkflow
      .createWorktree({
        cwd,
        refName: remoteRef,
        newRefName: branch,
        ...(base === undefined ? {} : { baseRefName: base }),
        path: null,
      })
      .pipe(Effect.mapError(gitFailed(`Could not make a worktree on ${remoteRef}`)));
    const worktreePath = made.worktree.path;
    const tracking = git
      .statusDetailsLocal(worktreePath)
      .pipe(Effect.mapError(gitFailed(`Could not read ${branch} in ${worktreePath}`)));
    return yield* tracking.pipe(
      Effect.filterOrFail(
        (status) => status.upstreamRef === remoteRef,
        (status) =>
          failure(
            "orchestration_error",
            `${branch} here tracks ${status.upstreamRef ?? "nothing"}, not ${remoteRef}.`,
          ),
      ),
      Effect.andThen(finish(worktreePath, true)),
      Effect.onError(() =>
        removeWorktree(cwd, worktreePath).pipe(Effect.andThen(discardNewBranch(cwd, branch))),
      ),
    );
  });

  const open: WorktreeOpenBranch["Service"]["open"] = Effect.fn("WorktreeOpenBranch.open")(
    function* (scope, input) {
      if (!scope.capabilities.has("worktree")) {
        return yield* failure(
          "capability_denied",
          "This MCP credential does not grant worktree capabilities.",
        );
      }
      const branch = input.branch.replace(/^refs\/heads\//, "");
      if (branch.startsWith("-") || branch === "HEAD") {
        return yield* failure("invalid_request", `${input.branch} is not a branch name.`);
      }
      if (input.expectCommit !== undefined && !COMMIT_ID.test(input.expectCommit)) {
        return yield* failure("invalid_request", "expectCommit must be a commit id.");
      }
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failure("invalid_request", "The project was not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      return yield* branchLocks.withLock(
        `${project.workspaceRoot}\u0000${branch}`,
        openLocked(project.workspaceRoot, branch, input),
      );
    },
  );

  return WorktreeOpenBranch.of({ open });
});

export const layer = Layer.effect(WorktreeOpenBranch, make);
