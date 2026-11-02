import type { VcsRef } from "@t3tools/contracts";

export type HandoffTargetRef = Pick<
  VcsRef,
  "name" | "isRemote" | "remoteName" | "worktreePath" | "upstreamRef"
>;

/** One request per call, each to the target machine; a call throws when the machine refuses it. */
export interface HandoffTargetGitIo {
  /** Asks the machine to fetch what its checkout tracks; it may answer from a recent fetch. */
  readonly refresh: () => Promise<void>;
  /** Every ref whose name holds the query, remote ones included, across all pages. */
  readonly listRefs: (query: string) => Promise<ReadonlyArray<HandoffTargetRef>>;
  readonly createWorktree: (input: {
    readonly refName: string;
    readonly newRefName?: string;
    readonly baseRefName?: string;
  }) => Promise<{ readonly path: string }>;
  /** Fetches the remote the checkout tracks and fast-forwards to it, never merging. */
  readonly pull: (cwd: string) => Promise<{ readonly upstreamRef: string | null }>;
  readonly status: (cwd: string) => Promise<{
    readonly hasUpstream: boolean;
    readonly aheadCount: number;
    readonly behindCount: number;
    /** What the branch is compared with in pull requests. */
    readonly baseRef: string | null;
  }>;
  /** The checkout's commits since the base it compares with, newest first. */
  readonly commits: (
    cwd: string,
  ) => Promise<{ readonly shas: ReadonlyArray<string>; readonly truncated: boolean }>;
  readonly removeWorktree: (path: string) => Promise<void>;
  readonly wait: (ms: number) => Promise<void>;
}

/** The machine fetches at most every 15 seconds, so the last wait runs past that. */
const VISIBLE_RETRY_DELAYS_MS = [3_000, 5_000, 8_000, 12_000];

function errorText(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "it failed";
}

/** A ref as a branch is named on its remote: without `refs/...` or the remote in front. */
function bareBranchName(ref: string, remote: string): string {
  const unqualified = ref.replace(/^refs\/(?:heads|remotes)\//, "");
  return unqualified.startsWith(`${remote}/`) ? unqualified.slice(remote.length + 1) : unqualified;
}

/**
 * Puts the pushed branch on a worktree of the target machine under the same name, tracking the
 * remote branch and keeping the pull request base. Its own refs may be old, so the worktree
 * fetches the remote and must hold the pushed commit. An existing branch of that name is used only
 * if no worktree has it, it tracks that remote branch and fast-forwards; else it is left alone.
 */
export async function prepareHandoffTargetWorktree(input: {
  readonly io: HandoffTargetGitIo;
  readonly targetLabel: string;
  readonly branch: string;
  /** The target machine's name for the remote the work was pushed to. */
  readonly remote: string;
  readonly comparisonBase: string | null;
  /** The commit the source pushed, when it could be named. */
  readonly expectedCommit: string | null;
  readonly onPhase: (phase: "fetch" | "worktree") => void;
}): Promise<{ readonly worktreePath: string; readonly branch: string }> {
  const { io, targetLabel, branch, remote, comparisonBase, expectedCommit } = input;
  const remoteRef = `${remote}/${branch}`;
  const base = comparisonBase === null ? null : bareBranchName(comparisonBase, remote);
  input.onPhase("fetch");
  let local: HandoffTargetRef | undefined;
  for (let attempt = 0; ; attempt += 1) {
    // Only what the machine then lists counts; a failed request may still have fetched.
    await io.refresh().catch(() => undefined);
    const refs = await io.listRefs(branch);
    local = refs.find((ref) => ref.isRemote !== true && ref.name === branch);
    if (refs.some((ref) => ref.isRemote === true && ref.name === remoteRef)) break;
    const delay = VISIBLE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      throw new Error(
        `${targetLabel} cannot see ${branch} on ${remote} yet. Check that it can reach the remote, then try again.`,
      );
    }
    await io.wait(delay);
  }
  input.onPhase("worktree");
  if (comparisonBase !== null && base !== null) {
    // Without it the worktree could not keep the base the thread's pull request compares with.
    const candidates = await io.listRefs(base);
    const found = candidates.some(
      (ref) => ref.name === base || (ref.isRemote === true && ref.name.endsWith(`/${base}`)),
    );
    if (!found) {
      throw new Error(
        `${targetLabel} does not have ${comparisonBase}, which this thread's pull request compares with.`,
      );
    }
  }

  const create = async (request: Parameters<HandoffTargetGitIo["createWorktree"]>[0]) => {
    try {
      return await io.createWorktree(request);
    } catch (error) {
      // A hook can fail after git registered the worktree; the branch then shows it checked out.
      const leftover = await io
        .listRefs(branch)
        .then(
          (refs) => refs.find((ref) => ref.isRemote !== true && ref.name === branch)?.worktreePath,
        )
        .catch(() => null);
      if (leftover) await io.removeWorktree(leftover).catch(() => undefined);
      throw error;
    }
  };
  /** Fetches what the worktree tracks and checks that it brought the pushed commit. */
  const bringUpToDate = async (worktreePath: string) => {
    const pulled = await io.pull(worktreePath).catch((error: unknown) => {
      throw new Error(
        `${branch} on ${targetLabel} could not be brought up to date with ${remoteRef}: ${errorText(error)}.`,
      );
    });
    if (pulled.upstreamRef !== remoteRef) {
      throw new Error(
        `${branch} on ${targetLabel} tracks ${pulled.upstreamRef ?? "nothing"}, not ${remoteRef}.`,
      );
    }
    if (expectedCommit === null) return;
    const { shas } = await io.commits(worktreePath);
    if (!shas.includes(expectedCommit)) {
      throw new Error(
        `${targetLabel} fetched ${remoteRef}, but it does not have your latest commit (${expectedCommit.slice(0, 7)}). Check that ${remote} on ${targetLabel} is the repository that was pushed to.`,
      );
    }
  };
  const withWorktreeRemovedOnFailure = async (worktreePath: string, check: () => Promise<void>) => {
    try {
      await check();
      return { worktreePath, branch };
    } catch (error) {
      await io.removeWorktree(worktreePath).catch(() => undefined);
      throw error;
    }
  };

  if (local === undefined) {
    const made = await create({
      refName: remoteRef,
      newRefName: branch,
      ...(comparisonBase === null ? {} : { baseRefName: comparisonBase }),
    });
    return withWorktreeRemovedOnFailure(made.path, () => bringUpToDate(made.path));
  }

  if (local.worktreePath !== null) {
    throw new Error(
      `${branch} is already checked out in ${local.worktreePath} on ${targetLabel}. Finish or remove that worktree, then try again.`,
    );
  }
  if (local.upstreamRef !== `refs/remotes/${remoteRef}`) {
    const tracked = local.upstreamRef?.replace(/^refs\/(?:heads|remotes)\//, "") ?? "nothing";
    throw new Error(
      `${branch} already exists on ${targetLabel} and tracks ${tracked}, not ${remoteRef}, so it was left alone.`,
    );
  }
  const made = await create({ refName: branch });
  return withWorktreeRemovedOnFailure(made.path, async () => {
    // Before the fetch moves the branch, so a refusal leaves it as it was.
    const status = await io.status(made.path);
    if (!status.hasUpstream) {
      throw new Error(
        `${branch} on ${targetLabel} does not track ${remoteRef}, so it was left alone.`,
      );
    }
    if (status.aheadCount > 0) {
      throw new Error(
        `${branch} on ${targetLabel} has commits that ${remoteRef} does not, so it was left alone.`,
      );
    }
    if (base !== null) {
      const actual = status.baseRef === null ? null : bareBranchName(status.baseRef, remote);
      if (actual !== base) {
        throw new Error(
          `${branch} on ${targetLabel} compares against ${status.baseRef ?? "nothing"}, not ${comparisonBase}, as this thread's pull request does. It cannot be changed from here, so it was left alone.`,
        );
      }
    }
    await bringUpToDate(made.path);
  });
}
