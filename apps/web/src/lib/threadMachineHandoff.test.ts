import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  HandoffCodePlan,
  HandoffReady,
  HandoffStep,
  ThreadMachineHandoffPlan,
} from "@t3tools/client-runtime/thread-machine-handoff";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import {
  runThreadMachineHandoff,
  type HandoffDraftRequest,
  type HandoffStepState,
  type ThreadMachineHandoffIo,
} from "./threadMachineHandoff";

const server = EnvironmentId.make("server");
const draftId = DraftId.make("draft-1");
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };
const identity = (remoteName: string): RepositoryIdentity => ({
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote",
    remoteName,
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
});

function plan(code: HandoffCodePlan, overrides: Partial<HandoffReady> = {}): HandoffReady {
  return {
    kind: "ready",
    code,
    sourceIdentity: identity("origin"),
    target: {
      environmentId: server,
      label: "Server",
      project: scopeProjectRef(server, ProjectId.make("project")),
      cwd: "/work/target",
      identity: identity("origin"),
    },
    transcript: { attach: true, maxBytes: 1_000 },
    modelSelection: model,
    ...overrides,
  };
}

const carryOnNewBranch: HandoffCodePlan = {
  kind: "carry",
  branch: "handoff/fix-login",
  createBranch: true,
  commit: { fileCount: 2, message: "WIP: hand off to Server", paths: ["a.ts", "b.ts"] },
  comparisonBase: "origin/main",
};

// The plan each io is run with, which a later read of the checkout finds unchanged by default.
const plans = new WeakMap<ThreadMachineHandoffIo, HandoffReady>();

function fakes(overrides: Partial<ThreadMachineHandoffIo> = {}, fresh?: ThreadMachineHandoffPlan) {
  const calls: Array<string> = [];
  const drafts: Array<HandoffDraftRequest> = [];
  const conversation = new File(["{}"], "thread.jsonl", { type: "application/x-ndjson" });
  const io: ThreadMachineHandoffIo = {
    readConversation: async () => {
      calls.push("read conversation");
      return conversation;
    },
    replan: async () => {
      calls.push("replan");
      return fresh ?? plans.get(io)!;
    },
    readTip: async () => {
      calls.push("read tip");
      return "tip-before";
    },
    createBranch: async (name) => {
      calls.push(`create branch ${name}`);
    },
    commitAndPush: async ({ commitMessage, onPhase }) => {
      calls.push(`commit and push "${commitMessage}"`);
      onPhase("commit");
      onPhase("push");
      return { upstreamBranch: "origin/handoff/fix-login", commitSha: "wip-commit" };
    },
    prepareTarget: async ({ pushed, comparisonBase, expectedCommit, onPhase }) => {
      calls.push(`prepare ${pushed.remoteRef} from ${comparisonBase} for ${expectedCommit}`);
      onPhase("fetch");
      onPhase("worktree");
      return { worktreePath: "/worktrees/handoff", branch: pushed.branch };
    },
    removeTargetWorktree: async (path) => {
      calls.push(`remove ${path}`);
    },
    openDraft: async (request) => {
      calls.push("open draft");
      drafts.push(request);
      return draftId;
    },
    ...overrides,
  };
  return { io, calls, drafts, conversation };
}

async function run(
  handoff: HandoffReady,
  io: ThreadMachineHandoffIo,
  steps: Array<`${HandoffStep} ${HandoffStepState}`> = [],
) {
  plans.set(io, handoff);
  return runThreadMachineHandoff({
    plan: handoff,
    title: "Fix the flaky login test",
    sourceLabel: "Laptop",
    threadLink: null,
    io,
    onStep: (step, state) => steps.push(`${step} ${state}`),
  });
}

describe("runThreadMachineHandoff", () => {
  it("reads the conversation, then moves the work, and only then opens the draft", async () => {
    const { io, calls, drafts, conversation } = fakes();
    const steps: Array<`${HandoffStep} ${HandoffStepState}`> = [];
    const result = await run(plan(carryOnNewBranch), io, steps);
    expect(result).toEqual({ ok: true, draftId });
    expect(calls).toEqual([
      "read conversation",
      "replan",
      "read tip",
      "create branch handoff/fix-login",
      'commit and push "WIP: hand off to Server"',
      "prepare origin/handoff/fix-login from origin/main for wip-commit",
      "open draft",
    ]);
    expect(steps).toEqual([
      "conversation running",
      "conversation done",
      "branch running",
      "branch done",
      "commit running",
      "commit done",
      "push running",
      "push done",
      "fetch running",
      "fetch done",
      "worktree running",
      "worktree done",
      "draft running",
      "draft done",
    ]);
    expect(drafts[0]).toMatchObject({
      conversation,
      worktree: { path: "/worktrees/handoff", branch: "handoff/fix-login" },
      modelSelection: model,
    });
    expect(drafts[0]?.note).toContain("`handoff/fix-login`");
    expect(drafts[0]?.note).toContain("`origin/handoff/fix-login`");
  });

  it("checks the checkout still is what was planned before it changes anything", async () => {
    const moved = plan({ ...carryOnNewBranch, branch: "handoff/other", createBranch: false });
    const { io, calls } = fakes({}, moved);
    const result = await run(plan(carryOnNewBranch), io);
    expect(result).toMatchObject({ ok: false, step: "branch", leftLocalCommit: false });
    expect(result.ok ? "" : result.message).toContain("changed");
    expect(calls).toEqual(["read conversation", "replan"]);
  });

  it("hands the target the commit it must hold: the one made, else the one already there", async () => {
    const committed = fakes();
    await run(plan(carryOnNewBranch), committed.io);
    expect(committed.calls).toContain(
      "prepare origin/handoff/fix-login from origin/main for wip-commit",
    );

    const pushedOnly = fakes({
      commitAndPush: async () => ({
        upstreamBranch: "origin/handoff/fix-login",
        commitSha: undefined,
      }),
    });
    await run(plan({ ...carryOnNewBranch, createBranch: false, commit: null }), pushedOnly.io);
    expect(pushedOnly.calls).toContain(
      "prepare origin/handoff/fix-login from origin/main for tip-before",
    );
  });

  it("changes nothing when the source's current commit cannot be read", async () => {
    const { io, calls } = fakes({
      readTip: async () => {
        throw new Error("This connection cannot read files.");
      },
    });
    expect(await run(plan(carryOnNewBranch), io)).toMatchObject({
      ok: false,
      step: "branch",
      message: "This connection cannot read files.",
      leftLocalCommit: false,
    });
    expect(calls).toEqual(["read conversation", "replan"]);
  });

  it("stops where the plan would now be blocked", async () => {
    const blocked: ThreadMachineHandoffPlan = {
      kind: "blocked",
      reason: "detached-head",
      message: "This checkout is not on a branch.",
    };
    const { io, calls } = fakes({}, blocked);
    expect(await run(plan(carryOnNewBranch), io)).toMatchObject({
      ok: false,
      message: "This checkout is not on a branch.",
    });
    expect(calls).toEqual(["read conversation", "replan"]);
  });

  it("continues the branch it pushed to the remote the machine knows it by, with that base", async () => {
    const { io, calls } = fakes({
      commitAndPush: async () => ({
        upstreamBranch: "fork/handoff/fix-login",
        commitSha: "wip-commit",
      }),
    });
    const forked = plan(carryOnNewBranch, {
      sourceIdentity: { ...identity("fork"), canonicalKey: "github.com/t3tools/t3code" },
      target: { ...plan(carryOnNewBranch).target, identity: identity("github") },
    });
    await run(forked, io);
    expect(calls).toContain("prepare github/handoff/fix-login from origin/main for wip-commit");
  });

  it("stops after a push to a remote it cannot match, with no worktree or draft", async () => {
    const { io, calls } = fakes({
      commitAndPush: async () => ({
        upstreamBranch: "publish/handoff/fix-login",
        commitSha: "wip-commit",
      }),
    });
    const result = await run(plan(carryOnNewBranch), io);
    expect(result).toMatchObject({ ok: false, step: "push", leftLocalCommit: false });
    expect(result.ok ? "" : result.message).toContain("publish");
    expect(calls.some((call) => call.startsWith("prepare") || call === "open draft")).toBe(false);
  });

  it("stops at the step that failed on the target, and opens no draft", async () => {
    const { io, calls } = fakes({
      prepareTarget: async ({ onPhase }) => {
        onPhase("fetch");
        throw new Error("Server cannot see handoff/fix-login on origin yet.");
      },
    });
    expect(await run(plan(carryOnNewBranch), io)).toEqual({
      ok: false,
      step: "fetch",
      message: "Server cannot see handoff/fix-login on origin yet.",
      leftLocalCommit: false,
    });
    expect(calls).not.toContain("open draft");
  });

  it("takes the new worktree down again when the draft cannot be opened", async () => {
    const { io, calls } = fakes({
      openDraft: async () => {
        throw new Error("Could not open a draft on Server.");
      },
    });
    expect(await run(plan(carryOnNewBranch), io)).toMatchObject({ ok: false, step: "draft" });
    expect(calls.at(-1)).toBe("remove /worktrees/handoff");
  });

  it("opens a draft on the machine's defaults when no code travels", async () => {
    const { io, calls, drafts } = fakes();
    const result = await run(plan({ kind: "none", reason: "no-remote" }), io);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["read conversation", "open draft"]);
    expect(drafts[0]?.worktree).toBeNull();
  });

  it("leaves the conversation off a machine that takes no files, and says so", async () => {
    const { io, calls, drafts } = fakes();
    await run(
      plan(
        { kind: "none", reason: "nothing-to-carry" },
        { transcript: { attach: false, maxBytes: null } },
      ),
      io,
    );
    expect(calls).toEqual(["open draft"]);
    expect(drafts[0]?.conversation).toBeNull();
  });

  it("pushes without a commit of its own when everything is committed", async () => {
    const { io, calls } = fakes();
    await run(plan({ ...carryOnNewBranch, createBranch: false, commit: null }), io);
    expect(calls.slice(0, 4)).toEqual([
      "read conversation",
      "replan",
      "read tip",
      'commit and push "WIP: hand off to Server"',
    ]);
  });

  it("changes nothing in git when the conversation cannot be read", async () => {
    const { io, calls } = fakes({
      readConversation: async () => {
        throw new Error("This thread exceeds the attachment size limit.");
      },
    });
    expect(await run(plan(carryOnNewBranch), io)).toEqual({
      ok: false,
      step: "conversation",
      message: "This thread exceeds the attachment size limit.",
      leftLocalCommit: false,
    });
    expect(calls).toEqual([]);
  });

  it("changes nothing in git when the conversation is bigger than the machine accepts", async () => {
    const big = new File([new Uint8Array(2_000)], "thread.jsonl");
    const { io, calls } = fakes({ readConversation: async () => big });
    const result = await run(plan(carryOnNewBranch), io);
    expect(result).toMatchObject({ ok: false, step: "conversation", leftLocalCommit: false });
    expect(result.ok ? "" : result.message).toContain("Server accepts as an attachment");
    expect(calls).toEqual([]);
  });

  it("stops at a branch it could not create", async () => {
    const { io, calls } = fakes({
      createBranch: async () => {
        throw new Error("A branch named handoff/fix-login already exists.");
      },
    });
    const result = await run(plan(carryOnNewBranch), io);
    expect(result).toMatchObject({ ok: false, step: "branch", leftLocalCommit: false });
    expect(calls).toEqual(["read conversation", "replan", "read tip"]);
  });

  it("reports a commit that failed as nothing left behind, and opens no draft", async () => {
    const { io, calls } = fakes({
      commitAndPush: async ({ onPhase }) => {
        onPhase("commit");
        throw new Error("pre-commit hook failed");
      },
    });
    expect(await run(plan(carryOnNewBranch), io)).toEqual({
      ok: false,
      step: "commit",
      message: "pre-commit hook failed",
      leftLocalCommit: false,
    });
    expect(calls).not.toContain("open draft");
  });

  it("reports the WIP commit that could not be pushed, and opens no draft", async () => {
    const { io, calls } = fakes({
      commitAndPush: async ({ onPhase }) => {
        onPhase("commit");
        onPhase("push");
        throw new Error("Authentication failed");
      },
    });
    expect(await run(plan(carryOnNewBranch), io)).toEqual({
      ok: false,
      step: "push",
      message: "Authentication failed",
      leftLocalCommit: true,
    });
    expect(calls).not.toContain("open draft");
  });

  it("reports a commit made for changes that appeared after the plan", async () => {
    const { io } = fakes({
      commitAndPush: async ({ onPhase }) => {
        onPhase("commit");
        onPhase("push");
        throw new Error("rejected");
      },
    });
    const result = await run(plan({ ...carryOnNewBranch, createBranch: false, commit: null }), io);
    expect(result).toMatchObject({ ok: false, step: "push", leftLocalCommit: true });
  });

  it("does not claim a local commit when the server found nothing to commit", async () => {
    const { io } = fakes({
      commitAndPush: async ({ onPhase }) => {
        onPhase("push");
        throw new Error("rejected");
      },
    });
    expect(await run(plan(carryOnNewBranch), io)).toMatchObject({
      ok: false,
      step: "push",
      leftLocalCommit: false,
    });
  });

  it("does not claim a local commit when only a push was asked for", async () => {
    const { io } = fakes({
      commitAndPush: async ({ onPhase }) => {
        onPhase("push");
        throw new Error("rejected");
      },
    });
    const result = await run(plan({ ...carryOnNewBranch, createBranch: false, commit: null }), io);
    expect(result).toMatchObject({ ok: false, step: "push", leftLocalCommit: false });
  });

  it("reports a failed draft without calling the pushed work a local commit", async () => {
    const { io } = fakes({
      openDraft: async () => {
        throw new Error("Could not open a draft on Server.");
      },
    });
    expect(await run(plan(carryOnNewBranch), io)).toEqual({
      ok: false,
      step: "draft",
      message: "Could not open a draft on Server.",
      leftLocalCommit: false,
    });
  });

  it("stops when the push reported no branch, rather than guess one", async () => {
    const { io, calls } = fakes({
      commitAndPush: async () => ({ upstreamBranch: undefined, commitSha: undefined }),
    });
    expect(await run(plan(carryOnNewBranch), io)).toMatchObject({ ok: false, step: "push" });
    expect(calls).not.toContain("open draft");
  });
});
