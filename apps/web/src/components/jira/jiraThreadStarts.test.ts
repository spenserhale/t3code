import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  fanoutBranches,
  followUpToRename,
  forgetJiraThreadStart,
  jiraWorktreeBranchFor,
  nextStepForThreadStart,
  planJiraFanout,
  registerJiraThreadStart,
  renameOutcome,
  threadStartPlan,
  type JiraThreadStart,
} from "./jiraThreadStarts";

const start: JiraThreadStart = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  issueKey: "PROJ-12",
  title: "PROJ-12: Fix the login redirect",
  branch: "PROJ-12-fix-the-login-redirect",
  startedAt: 1_000,
};
const { startedAt: _startedAt, ...registration } = start;

const shell = (overrides: Partial<Parameters<typeof nextStepForThreadStart>[0] & object> = {}) => ({
  title: "Fix login redirect",
  titleRegeneration: null,
  latestUserMessageAt: "2026-11-02T08:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

describe("nextStepForThreadStart", () => {
  it("waits until the thread has its first message and the generated title has settled", () => {
    expect(nextStepForThreadStart(null, start)).toBe("wait");
    expect(nextStepForThreadStart(shell({ latestUserMessageAt: null }), start)).toBe("wait");
    expect(
      nextStepForThreadStart(
        shell({ titleRegeneration: { requestId: "r", startedAt: "t" } }),
        start,
      ),
    ).toBe("wait");
  });

  it("gives a settled title the key and summary", () => {
    expect(nextStepForThreadStart(shell(), start)).toBe("rename");
    expect(nextStepForThreadStart(shell({ title: "Fix PROJ-1 and PROJ-120" }), start)).toBe(
      "rename",
    );
  });

  it("leaves a title that already names the issue, and a deleted thread, alone", () => {
    expect(nextStepForThreadStart(shell({ title: "PROJ-12: Fix login" }), start)).toBe("done");
    expect(nextStepForThreadStart(shell({ deletedAt: "2026-11-02T00:00:00.000Z" }), start)).toBe(
      "done",
    );
  });
});

describe("started threads on this device", () => {
  it("hands the composer the branch to create, until the thread is forgotten", () => {
    expect(jiraWorktreeBranchFor(start.threadId)).toEqual({});
    registerJiraThreadStart(registration);
    registerJiraThreadStart({ ...registration, branch: null, threadId: ThreadId.make("thread-2") });
    expect(jiraWorktreeBranchFor(start.threadId)).toEqual({
      branch: "PROJ-12-fix-the-login-redirect",
    });
    expect(jiraWorktreeBranchFor(ThreadId.make("thread-2"))).toEqual({});
    forgetJiraThreadStart(start.threadId);
    expect(jiraWorktreeBranchFor(start.threadId)).toEqual({});
  });
});

describe("threadStartPlan", () => {
  it.each([
    { isRepository: true, failed: false, choice: null, expected: { ready: true, worktree: true } },
    { isRepository: true, failed: false, choice: true, expected: { ready: true, worktree: true } },
    {
      isRepository: true,
      failed: false,
      choice: false,
      expected: { ready: true, worktree: false },
    },
    {
      isRepository: false,
      failed: false,
      choice: null,
      expected: { ready: true, worktree: false },
    },
    {
      isRepository: false,
      failed: false,
      choice: true,
      expected: { ready: true, worktree: false },
    },
  ])(
    "repository $isRepository, choice $choice starts as soon as it is known",
    ({ isRepository, failed, choice, expected }) => {
      expect(threadStartPlan({ isRepository, detectionFailed: failed, choice })).toEqual(expected);
    },
  );

  it("waits for the repository check instead of starting without a worktree", () => {
    expect(threadStartPlan({ isRepository: null, detectionFailed: false, choice: null })).toEqual({
      ready: false,
      reason: "checking",
    });
    expect(threadStartPlan({ isRepository: null, detectionFailed: false, choice: true })).toEqual({
      ready: false,
      reason: "checking",
    });
  });

  it("starts without a worktree only when the person says so after the check failed", () => {
    expect(threadStartPlan({ isRepository: null, detectionFailed: true, choice: null })).toEqual({
      ready: false,
      reason: "unknown",
    });
    expect(threadStartPlan({ isRepository: null, detectionFailed: true, choice: true })).toEqual({
      ready: false,
      reason: "unknown",
    });
    expect(threadStartPlan({ isRepository: null, detectionFailed: true, choice: false })).toEqual({
      ready: true,
      worktree: false,
    });
  });
});

describe("followUpToRename", () => {
  it("forgets a start once the rename went through, or can never go through", () => {
    expect(followUpToRename("renamed", 0)).toBe("forget");
    expect(followUpToRename("refused", 1)).toBe("forget");
  });

  it("keeps a start after a failure that may pass, trying again later and then no more this session", () => {
    expect(followUpToRename("failed", 1)).toEqual({ retryInMs: 5_000 });
    expect(followUpToRename("failed", 2)).toEqual({ retryInMs: 15_000 });
    expect(followUpToRename("failed", 5)).toEqual({ retryInMs: 300_000 });
    expect(followUpToRename("failed", 6)).toBe("keep");
  });
});

describe("renameOutcome", () => {
  it("tells a rename that went through from one that was refused and one that failed", () => {
    expect(renameOutcome({ _tag: "Success" })).toBe("renamed");
    expect(
      renameOutcome({
        _tag: "Failure",
        cause: Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: "This connection cannot change threads or projects.",
          }),
        ),
      }),
    ).toBe("refused");
    expect(renameOutcome({ _tag: "Failure", cause: Cause.fail(new Error("socket closed")) })).toBe(
      "failed",
    );
    expect(renameOutcome({ _tag: "Failure", cause: Cause.die("boom") })).toBe("failed");
    expect(renameOutcome({ _tag: "Failure", cause: Cause.interrupt() })).toBe("failed");
  });
});

describe("fanoutBranches", () => {
  it("keeps the registered branch for the first thread and numbers the rest", () => {
    expect(fanoutBranches("PROJ-12-fix-login", 3, new Set())).toEqual([
      "PROJ-12-fix-login",
      "PROJ-12-fix-login-2",
      "PROJ-12-fix-login-3",
    ]);
  });

  it("steps over names other threads have claimed", () => {
    expect(fanoutBranches("PROJ-12-fix-login", 3, new Set(["PROJ-12-fix-login-2"]))).toEqual([
      "PROJ-12-fix-login",
      "PROJ-12-fix-login-3",
      "PROJ-12-fix-login-4",
    ]);
  });
});

describe("planJiraFanout", () => {
  const parent = ThreadId.make("draft-thread");
  const child = (index: number) => ThreadId.make(`child-${index}`);

  it("does nothing for a thread that was not started from an issue", () => {
    const plan = planJiraFanout(ThreadId.make("unrelated"), 2);
    expect(plan.adopt(0, child(0))).toEqual({});
    expect(jiraWorktreeBranchFor(child(0))).toEqual({});
    plan.finish();
  });

  it("registers every child for its title and gives each a branch of its own", () => {
    registerJiraThreadStart({ ...registration, threadId: parent });
    registerJiraThreadStart({
      ...registration,
      threadId: ThreadId.make("other-draft"),
      branch: "PROJ-12-fix-the-login-redirect-2",
    });
    const plan = planJiraFanout(parent, 3);
    expect(plan.adopt(0, child(0))).toEqual({ branch: "PROJ-12-fix-the-login-redirect" });
    expect(plan.adopt(1, child(1))).toEqual({ branch: "PROJ-12-fix-the-login-redirect-3" });
    expect(plan.adopt(2, child(2))).toEqual({ branch: "PROJ-12-fix-the-login-redirect-4" });
    expect(jiraWorktreeBranchFor(child(1))).toEqual({
      branch: "PROJ-12-fix-the-login-redirect-3",
    });
    // The draft's own entry stays until every child has started, in case one has to be retried.
    expect(jiraWorktreeBranchFor(parent)).toEqual({ branch: "PROJ-12-fix-the-login-redirect" });
    plan.finish();
    expect(jiraWorktreeBranchFor(parent)).toEqual({});
    expect(jiraWorktreeBranchFor(child(2))).toEqual({
      branch: "PROJ-12-fix-the-login-redirect-4",
    });
    for (const id of ["other-draft", "child-0", "child-1", "child-2"]) {
      forgetJiraThreadStart(ThreadId.make(id));
    }
  });

  it("registers children of a thread that asked for no worktree without branches", () => {
    registerJiraThreadStart({ ...registration, threadId: parent, branch: null });
    const plan = planJiraFanout(parent, 2);
    expect(plan.adopt(1, child(1))).toEqual({});
    expect(jiraWorktreeBranchFor(child(1))).toEqual({});
    plan.finish();
    forgetJiraThreadStart(child(1));
  });
});
