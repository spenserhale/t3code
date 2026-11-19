import { describe, expect, it } from "vite-plus/test";

import {
  prepareHandoffTargetWorktree,
  type HandoffTargetGitIo,
  type HandoffTargetRef,
} from "./handoffTargetBranch";

const pushed = "a".repeat(40);
const older = "b".repeat(40);

const remoteRef: HandoffTargetRef = {
  name: "origin/feature/login",
  isRemote: true,
  remoteName: "origin",
  worktreePath: null,
};
const baseRef: HandoffTargetRef = {
  name: "origin/main",
  isRemote: true,
  remoteName: "origin",
  worktreePath: null,
};
const localRef = (
  overrides: { worktreePath?: string; upstreamRef?: string | null } = {},
): HandoffTargetRef => ({
  name: "feature/login",
  worktreePath: overrides.worktreePath ?? null,
  // A branch that tracks nothing has no upstream to list.
  ...(overrides.upstreamRef === null
    ? {}
    : { upstreamRef: overrides.upstreamRef ?? "refs/remotes/origin/feature/login" }),
});

interface Overrides {
  /** What each listing of the machine's refs returns; the last one stays. */
  refs: ReadonlyArray<ReadonlyArray<HandoffTargetRef>>;
  pull: Awaited<ReturnType<HandoffTargetGitIo["pull"]>>;
  pullError: Error;
  status: Partial<Awaited<ReturnType<HandoffTargetGitIo["status"]>>>;
  commits: ReadonlyArray<string>;
  createError: Error;
  listError: Error;
  refreshError: Error;
}

function harness(
  overrides: Partial<Overrides> = {},
  expectedCommit: string | null = pushed,
  comparisonBase = "origin/main",
) {
  const calls: string[] = [];
  const reads = [...(overrides.refs ?? [[remoteRef, baseRef]])];
  const io: HandoffTargetGitIo = {
    refresh: async () => {
      calls.push("refresh");
      if (overrides.refreshError) throw overrides.refreshError;
    },
    listRefs: async (query) => {
      calls.push(`list:${query}`);
      if (overrides.listError) throw overrides.listError;
      return reads.length > 1 ? reads.shift()! : (reads[0] ?? []);
    },
    createWorktree: async (input) => {
      calls.push(`create:${input.refName}>${input.newRefName ?? "-"}@${input.baseRefName ?? "-"}`);
      if (overrides.createError) throw overrides.createError;
      return { path: "/worktrees/feature-login" };
    },
    pull: async (cwd) => {
      calls.push(`pull:${cwd}`);
      if (overrides.pullError) throw overrides.pullError;
      return overrides.pull ?? { upstreamRef: "origin/feature/login" };
    },
    status: async (cwd) => {
      calls.push(`status:${cwd}`);
      return {
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        baseRef: "origin/main",
        ...overrides.status,
      };
    },
    commits: async (cwd) => {
      calls.push(`commits:${cwd}`);
      return { shas: overrides.commits ?? [pushed, older], truncated: false };
    },
    removeWorktree: async (path) => {
      calls.push(`remove:${path}`);
    },
    wait: async (ms) => {
      calls.push(`wait:${ms}`);
    },
  };
  const phases: string[] = [];
  const run = () =>
    prepareHandoffTargetWorktree({
      io,
      targetLabel: "Server",
      branch: "feature/login",
      remote: "origin",
      comparisonBase,
      expectedCommit,
      onPhase: (phase) => phases.push(phase),
    });
  return { calls, phases, run };
}

const created = "create:origin/feature/login>feature/login@origin/main";

describe("prepareHandoffTargetWorktree", () => {
  it("continues the pushed branch on a worktree that tracks it, fetched and holding the pushed commit", async () => {
    const { calls, phases, run } = harness();
    await expect(run()).resolves.toEqual({
      worktreePath: "/worktrees/feature-login",
      branch: "feature/login",
    });
    expect(calls).toEqual([
      "refresh",
      "list:feature/login",
      "list:main",
      created,
      "pull:/worktrees/feature-login",
      "commits:/worktrees/feature-login",
    ]);
    expect(phases).toEqual(["fetch", "worktree"]);
  });

  describe("code that is not the code that was pushed", () => {
    it("stops when the fetch left the branch without the pushed commit, and takes the worktree down", async () => {
      const { calls, run } = harness({ commits: [older] });
      await expect(run()).rejects.toThrow("does not have your latest commit (aaaaaaa)");
      expect(calls.at(-1)).toBe("remove:/worktrees/feature-login");
    });

    it("fetches the tracked remote itself, whatever the machine's status refresh did", async () => {
      const { calls, run } = harness({ refreshError: new Error("a cached refresh") });
      await run();
      expect(calls.indexOf("pull:/worktrees/feature-login")).toBeGreaterThan(
        calls.indexOf(created),
      );
    });

    it("stops, with the worktree taken down, when the branch cannot be fetched", async () => {
      const { calls, run } = harness({ pullError: new Error("Could not resolve host") });
      await expect(run()).rejects.toThrow("Could not resolve host");
      expect(calls.at(-1)).toBe("remove:/worktrees/feature-login");
    });

    it("stops when the fetch came from another remote than the one pushed to", async () => {
      const { calls, run } = harness({ pull: { upstreamRef: "fork/feature/login" } });
      await expect(run()).rejects.toThrow("tracks fork/feature/login, not origin/feature/login");
      expect(calls.at(-1)).toBe("remove:/worktrees/feature-login");
    });

    it("has nothing to compare when the push named no commit, and still fetches", async () => {
      const { calls, run } = harness({}, null);
      await run();
      expect(calls.some((call) => call.startsWith("commits:"))).toBe(false);
      expect(calls).toContain("pull:/worktrees/feature-login");
    });
  });

  describe("seeing the branch", () => {
    it("asks for the fetch again and waits while the machine cannot see the branch", async () => {
      const { calls, run } = harness({ refs: [[baseRef], [baseRef], [remoteRef, baseRef]] });
      await run();
      expect(calls.filter((call) => call.startsWith("wait:"))).toEqual(["wait:3000", "wait:5000"]);
      expect(calls.filter((call) => call === "refresh")).toHaveLength(3);
    });

    it("stops when the machine still cannot see the branch, with nothing created", async () => {
      const { calls, run } = harness({ refs: [[baseRef]] });
      await expect(run()).rejects.toThrow("Server cannot see feature/login on origin");
      expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
    });

    it("does not take a branch of the same name for the remote's", async () => {
      const { run } = harness({ refs: [[localRef(), baseRef]] });
      await expect(run()).rejects.toThrow("cannot see");
    });

    it("fails closed when the branches cannot be read", async () => {
      const { calls, run } = harness({ listError: new Error("offline") });
      await expect(run()).rejects.toThrow("offline");
      expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
    });

    it("goes on when asking for the fetch fails but the branch is there", async () => {
      const { run } = harness({ refreshError: new Error("busy") });
      await expect(run()).resolves.toMatchObject({ branch: "feature/login" });
    });
  });

  describe("the base the pull request compares with", () => {
    it("is needed on the machine before anything is made", async () => {
      const { calls, run } = harness({ refs: [[remoteRef]] });
      await expect(run()).rejects.toThrow("does not have origin/main");
      expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
    });

    it("is found as the remote's branch when the thread's side names it without a remote", async () => {
      const { calls, run } = harness({ refs: [[remoteRef, baseRef]] }, pushed, "main");
      await run();
      expect(calls).toContain("create:origin/feature/login>feature/login@main");
    });
  });

  describe("a worktree that did not come up cleanly", () => {
    it("is taken down when creating it failed after git had registered it", async () => {
      const onDisk = localRef({ worktreePath: "/worktrees/half-made", upstreamRef: null });
      const { calls, run } = harness({
        createError: new Error("post-checkout hook failed"),
        refs: [
          [remoteRef, baseRef],
          [remoteRef, baseRef],
          [remoteRef, baseRef, onDisk],
        ],
      });
      await expect(run()).rejects.toThrow("post-checkout hook failed");
      expect(calls.at(-1)).toBe("remove:/worktrees/half-made");
    });

    it("leaves nothing to remove when git registered nothing", async () => {
      const { calls, run } = harness({ createError: new Error("disk full") });
      await expect(run()).rejects.toThrow("disk full");
      expect(calls.some((call) => call.startsWith("remove:"))).toBe(false);
    });
  });

  describe("a branch of that name already on the machine", () => {
    const existing = { refs: [[remoteRef, baseRef, localRef()]] };

    it("is used when nothing has it checked out, it tracks the remote branch and it catches up", async () => {
      const { calls, run } = harness(existing);
      await expect(run()).resolves.toEqual({
        worktreePath: "/worktrees/feature-login",
        branch: "feature/login",
      });
      expect(calls.slice(3)).toEqual([
        "create:feature/login>-@-",
        "status:/worktrees/feature-login",
        "pull:/worktrees/feature-login",
        "commits:/worktrees/feature-login",
      ]);
    });

    it("is left alone when another worktree has it checked out", async () => {
      const { calls, run } = harness({
        refs: [[remoteRef, baseRef, localRef({ worktreePath: "/work/checkout" })]],
      });
      await expect(run()).rejects.toThrow("already checked out in /work/checkout on Server");
      expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
    });

    it.each([
      ["tracks another remote", "refs/remotes/fork/feature/login"],
      ["tracks a local branch", "refs/heads/main"],
      ["tracks nothing", null],
    ])("is not fetched or touched when it %s", async (_name, upstreamRef) => {
      const { calls, run } = harness({
        refs: [[remoteRef, baseRef, localRef({ upstreamRef })]],
      });
      await expect(run()).rejects.toThrow("left alone");
      expect(calls.some((call) => call.startsWith("create:") || call.startsWith("pull:"))).toBe(
        false,
      );
    });

    it.each([
      ["has commits the remote lacks", { aheadCount: 1, behindCount: 0 }],
      ["has diverged", { aheadCount: 1, behindCount: 2 }],
      ["tracks nothing yet", { hasUpstream: false }],
    ])("is left as it was, with its worktree removed, when it %s", async (_name, status) => {
      const { calls, run } = harness({ ...existing, status });
      await expect(run()).rejects.toThrow("left alone");
      expect(calls.some((call) => call.startsWith("pull:"))).toBe(false);
      expect(calls.at(-1)).toBe("remove:/worktrees/feature-login");
    });

    it("is left alone when it cannot be brought up to date without a merge", async () => {
      const { calls, run } = harness({
        ...existing,
        pullError: new Error("Not possible to fast-forward"),
      });
      await expect(run()).rejects.toThrow("Not possible to fast-forward");
      expect(calls.at(-1)).toBe("remove:/worktrees/feature-login");
    });

    it("must compare with the base the thread's pull request does, or it is left as it was", async () => {
      const { calls, run } = harness({ ...existing, status: { baseRef: "develop" } });
      await expect(run()).rejects.toThrow("compares against develop, not origin/main");
      expect(calls.some((call) => call.startsWith("pull:"))).toBe(false);
      expect(calls.at(-1)).toBe("remove:/worktrees/feature-login");
    });

    it.each(["main", "origin/main", "refs/remotes/origin/main", "refs/heads/main"])(
      "may name that base as %s",
      async (name) => {
        const { run } = harness({ ...existing, status: { baseRef: name } });
        await expect(run()).resolves.toMatchObject({ branch: "feature/login" });
      },
    );

    it("is left as it was when it compares with nothing", async () => {
      const { run } = harness({ ...existing, status: { baseRef: null } });
      await expect(run()).rejects.toThrow("compares against nothing");
    });
  });
});
