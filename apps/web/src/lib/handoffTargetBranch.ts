import type { VcsRef } from "@t3tools/contracts";

export type HandoffTargetRef = Pick<VcsRef, "name" | "isRemote" | "remoteName" | "worktreePath">;

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
  /** Fast-forwards the checkout to what it tracks, never merging. */
  readonly pull: (cwd: string) => Promise<{ readonly upstreamRef: string | null }>;
  readonly status: (
    cwd: string,
  ) => Promise<{ hasUpstream: boolean; aheadCount: number; behindCount: number }>;
  readonly removeWorktree: (path: string) => Promise<void>;
  readonly wait: (ms: number) => Promise<void>;
}

/** The machine fetches at most every 15 seconds, so the last wait runs past that. */
const VISIBLE_RETRY_DELAYS_MS = [3_000, 5_000, 8_000, 12_000];

function errorText(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "it failed";
}

/**
 * Puts the pushed branch on a worktree of the target machine under the same name, tracking the
 * remote branch and keeping the base pull requests compare with. A branch of that name already
 * there is used only if no worktree has it checked out and it fast-forwards; else it is left alone.
 */
export async function prepareHandoffTargetWorktree(input: {
  readonly io: HandoffTargetGitIo;
  readonly targetLabel: string;
  readonly branch: string;
  /** The target machine's name for the remote the work was pushed to. */
  readonly remote: string;
  readonly comparisonBase: string | null;
  readonly onPhase: (phase: "fetch" | "worktree") => void;
}): Promise<{ readonly worktreePath: string; readonly branch: string }> {
  const { io, targetLabel, branch } = input;
  const remoteRef = `${input.remote}/${branch}`;
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
        `${targetLabel} cannot see ${branch} on ${input.remote} yet. Check that it can reach the remote, then try again.`,
      );
    }
    await io.wait(delay);
  }
  input.onPhase("worktree");
  if (local === undefined) {
    const created = await io.createWorktree({
      refName: remoteRef,
      newRefName: branch,
      ...(input.comparisonBase === null ? {} : { baseRefName: input.comparisonBase }),
    });
    return { worktreePath: created.path, branch };
  }
  if (local.worktreePath !== null) {
    throw new Error(
      `${branch} is already checked out in ${local.worktreePath} on ${targetLabel}. Finish or remove that worktree, then try again.`,
    );
  }
  const created = await io.createWorktree({ refName: branch });
  try {
    const pulled = await io.pull(created.path).catch((error: unknown) => {
      throw new Error(
        `${branch} on ${targetLabel} could not be brought up to date with ${remoteRef}: ${errorText(error)}. It was left alone.`,
      );
    });
    if (pulled.upstreamRef !== remoteRef) {
      throw new Error(
        `${branch} already exists on ${targetLabel} and tracks ${pulled.upstreamRef ?? "nothing"}, not ${remoteRef}, so it was left alone.`,
      );
    }
    const status = await io.status(created.path);
    if (!status.hasUpstream) {
      throw new Error(
        `${branch} on ${targetLabel} does not track ${remoteRef}, so it was left alone.`,
      );
    }
    if (status.aheadCount > 0 || status.behindCount > 0) {
      throw new Error(
        `${branch} on ${targetLabel} has commits that ${remoteRef} does not, so it was left alone.`,
      );
    }
    return { worktreePath: created.path, branch };
  } catch (error) {
    await io.removeWorktree(created.path).catch(() => undefined);
    throw error;
  }
}
