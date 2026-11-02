import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  HandoffCodePlan,
  HandoffReady,
  HandoffStep,
} from "@t3tools/client-runtime/thread-machine-handoff";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
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

function plan(code: HandoffCodePlan, overrides: Partial<HandoffReady> = {}): HandoffReady {
  return {
    kind: "ready",
    code,
    target: {
      environmentId: server,
      label: "Server",
      project: scopeProjectRef(server, ProjectId.make("project")),
      remoteName: "origin",
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
  commit: { fileCount: 2, message: "WIP: hand off to Server" },
};

function fakes(overrides: Partial<ThreadMachineHandoffIo> = {}) {
  const calls: Array<string> = [];
  const drafts: Array<HandoffDraftRequest> = [];
  const conversation = new File(["{}"], "thread.jsonl", { type: "application/x-ndjson" });
  const io: ThreadMachineHandoffIo = {
    readConversation: async () => {
      calls.push("read conversation");
      return conversation;
    },
    createBranch: async (name) => {
      calls.push(`create branch ${name}`);
    },
    commitAndPush: async ({ commitMessage, onPhase }) => {
      calls.push(`commit and push "${commitMessage}"`);
      onPhase("commit");
      onPhase("push");
      return { upstreamBranch: "origin/handoff/fix-login" };
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
      "create branch handoff/fix-login",
      'commit and push "WIP: hand off to Server"',
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
      "draft running",
      "draft done",
    ]);
    expect(drafts[0]).toMatchObject({
      conversation,
      baseRef: "origin/handoff/fix-login",
      modelSelection: model,
    });
    expect(drafts[0]?.note).toContain("`origin/handoff/fix-login`");
  });

  it("opens a draft on the machine's defaults when no code travels", async () => {
    const { io, calls, drafts } = fakes();
    const result = await run(plan({ kind: "none", reason: "no-remote" }), io);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["read conversation", "open draft"]);
    expect(drafts[0]?.baseRef).toBeNull();
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
    expect(calls[1]).toBe('commit and push "WIP: hand off to Server"');
    expect(calls).toHaveLength(3);
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
    expect(calls).toEqual(["read conversation"]);
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

  it("starts the work from the pushed branch even when the push result names another remote", async () => {
    const { io, drafts } = fakes({
      commitAndPush: async () => ({ upstreamBranch: "fork/handoff/fix-login" }),
    });
    await run(
      plan(carryOnNewBranch, {
        target: { ...plan(carryOnNewBranch).target, remoteName: "github" },
      }),
      io,
    );
    expect(drafts[0]?.baseRef).toBe("github/handoff/fix-login");
  });

  it("opens a draft without a base when the push reported no branch", async () => {
    const { io, drafts } = fakes({ commitAndPush: async () => ({ upstreamBranch: undefined }) });
    await run(plan(carryOnNewBranch), io);
    expect(drafts[0]?.baseRef).toBeNull();
    expect(drafts[0]?.note).toContain("No code was carried over");
  });
});
