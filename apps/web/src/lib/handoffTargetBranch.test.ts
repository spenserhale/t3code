import { describe, expect, it } from "vite-plus/test";

import {
  prepareHandoffTargetWorktree,
  type HandoffTargetGitIo,
  type HandoffTargetRef,
} from "./handoffTargetBranch";

const remoteRef: HandoffTargetRef = {
  name: "origin/feature/login",
  isRemote: true,
  remoteName: "origin",
  worktreePath: null,
};
const localRef = (worktreePath: string | null): HandoffTargetRef => ({
  name: "feature/login",
  worktreePath,
});

function harness(
  overrides: Partial<{
    refs: ReadonlyArray<ReadonlyArray<HandoffTargetRef>>;
    pull: Awaited<ReturnType<HandoffTargetGitIo["pull"]>>;
    pullError: Error;
    status: Awaited<ReturnType<HandoffTargetGitIo["status"]>>;
    listError: Error;
    refreshError: Error;
  }> = {},
) {
  const calls: string[] = [];
  const reads = [...(overrides.refs ?? [[remoteRef]])];
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
      return { path: "/worktrees/feature-login" };
    },
    pull: async (cwd) => {
      calls.push(`pull:${cwd}`);
      if (overrides.pullError) throw overrides.pullError;
      return overrides.pull ?? { upstreamRef: "origin/feature/login" };
    },
    status: async (cwd) => {
      calls.push(`status:${cwd}`);
      return overrides.status ?? { hasUpstream: true, aheadCount: 0, behindCount: 0 };
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
      comparisonBase: "origin/main",
      onPhase: (phase) => phases.push(phase),
    });
  return { calls, phases, run };
}

describe("prepareHandoffTargetWorktree", () => {
  it("continues the pushed branch on a new worktree that tracks it and keeps the pull request base", async () => {
    const { calls, phases, run } = harness();
    await expect(run()).resolves.toEqual({
      worktreePath: "/worktrees/feature-login",
      branch: "feature/login",
    });
    expect(calls).toEqual([
      "refresh",
      "list:feature/login",
      "create:origin/feature/login>feature/login@origin/main",
    ]);
    expect(phases).toEqual(["fetch", "worktree"]);
  });

  it("asks for the fetch again and waits while the machine cannot see the branch", async () => {
    const { calls, run } = harness({ refs: [[], [], [remoteRef]] });
    await run();
    expect(calls.filter((call) => call.startsWith("wait:"))).toEqual(["wait:3000", "wait:5000"]);
    expect(calls.filter((call) => call === "refresh")).toHaveLength(3);
  });

  it("stops when the machine still cannot see the branch, with nothing created", async () => {
    const { calls, run } = harness({ refs: [[]] });
    await expect(run()).rejects.toThrow("Server cannot see feature/login on origin");
    expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
  });

  it("does not take a branch of the same name for the remote's", async () => {
    const { run } = harness({ refs: [[localRef(null)]] });
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

  describe("a branch of that name already on the machine", () => {
    it("is used when nothing has it checked out and it is level with the remote", async () => {
      const { calls, run } = harness({ refs: [[remoteRef, localRef(null)]] });
      await expect(run()).resolves.toEqual({
        worktreePath: "/worktrees/feature-login",
        branch: "feature/login",
      });
      expect(calls.slice(2)).toEqual([
        "create:feature/login>-@-",
        "pull:/worktrees/feature-login",
        "status:/worktrees/feature-login",
      ]);
    });

    it("is left alone when another worktree has it checked out", async () => {
      const { calls, run } = harness({ refs: [[remoteRef, localRef("/work/checkout")]] });
      await expect(run()).rejects.toThrow("already checked out in /work/checkout on Server");
      expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
    });

    it.each([
      ["tracks another branch", { upstreamRef: "fork/feature/login" }, undefined],
      [
        "has commits the remote lacks",
        undefined,
        { hasUpstream: true, aheadCount: 1, behindCount: 0 },
      ],
      ["has diverged", undefined, { hasUpstream: true, aheadCount: 1, behindCount: 2 }],
      ["tracks nothing", undefined, { hasUpstream: false, aheadCount: 0, behindCount: 0 }],
    ])(
      "is left alone, with its worktree removed again, when it %s",
      async (_name, pull, status) => {
        const { calls, run } = harness({
          refs: [[remoteRef, localRef(null)]],
          ...(pull ? { pull } : {}),
          ...(status ? { status } : {}),
        });
        await expect(run()).rejects.toThrow("left alone");
        expect(calls.at(-1)).toBe("remove:/worktrees/feature-login");
      },
    );

    it("is left alone when it cannot be brought up to date without a merge", async () => {
      const { calls, run } = harness({
        refs: [[remoteRef, localRef(null)]],
        pullError: new Error("Not possible to fast-forward"),
      });
      await expect(run()).rejects.toThrow("Not possible to fast-forward");
      expect(calls.at(-1)).toBe("remove:/worktrees/feature-login");
    });
  });
});
