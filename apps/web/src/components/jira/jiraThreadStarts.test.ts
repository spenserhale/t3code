import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  branchForFanoutChild,
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

describe("branchForFanoutChild", () => {
  const base = "PROJ-12-fix-login";

  it("gives a child the first free name from the draft's branch", () => {
    expect(branchForFanoutChild({ base, previous: null, taken: new Set() })).toBe(base);
    expect(branchForFanoutChild({ base, previous: null, taken: new Set([base]) })).toBe(
      `${base}-2`,
    );
    expect(
      branchForFanoutChild({ base, previous: null, taken: new Set([base, `${base}-2`]) }),
    ).toBe(`${base}-3`);
  });

  it("keeps the name a child had on an earlier attempt while it is still free", () => {
    expect(branchForFanoutChild({ base, previous: `${base}-2`, taken: new Set([base]) })).toBe(
      `${base}-2`,
    );
  });

  it("moves on from a name that has been taken since, rather than starting over", () => {
    expect(
      branchForFanoutChild({
        base,
        previous: `${base}-2`,
        taken: new Set([base, `${base}-2`]),
      }),
    ).toBe(`${base}-3`);
  });
});

describe("planJiraFanout", () => {
  const base = "PROJ-12-fix-the-login-redirect";
  const parent = ThreadId.make("draft-thread");
  const child = (index: number) => ThreadId.make(`child-${index}`);
  const repository =
    (...names: ReadonlyArray<string>) =>
    () =>
      Promise.resolve(new Set<string>(names));
  const cleanUp = (...ids: ReadonlyArray<string>) => {
    for (const id of ["draft-thread", "other-draft", ...ids])
      forgetJiraThreadStart(ThreadId.make(id));
  };

  it("does nothing for a thread that was not started from an issue", async () => {
    const read = vi.fn(repository());
    const plan = planJiraFanout(ThreadId.make("unrelated"), read);
    expect(await plan.adopt("a", child(0))).toEqual({});
    expect(jiraWorktreeBranchFor(child(0))).toEqual({});
    expect(read).not.toHaveBeenCalled();
    plan.finish();
  });

  it("registers every child for its title and gives each a branch of its own, base first", async () => {
    registerJiraThreadStart({ ...registration, threadId: parent });
    const plan = planJiraFanout(parent, repository());
    const branches = await Promise.all([
      plan.adopt("a", child(0)),
      plan.adopt("b", child(1)),
      plan.adopt("c", child(2)),
    ]);
    expect(branches).toEqual([{ branch: base }, { branch: `${base}-2` }, { branch: `${base}-3` }]);
    expect(jiraWorktreeBranchFor(child(2))).toEqual({ branch: `${base}-3` });
    // The draft's own entry stays until every child has started, in case one is retried.
    expect(jiraWorktreeBranchFor(parent)).toEqual({ branch: base });
    plan.finish();
    expect(jiraWorktreeBranchFor(parent)).toEqual({});
    cleanUp("child-0", "child-1", "child-2");
  });

  it("reads the repository once for all the children", async () => {
    registerJiraThreadStart({ ...registration, threadId: parent });
    const read = vi.fn(repository());
    const plan = planJiraFanout(parent, read);
    await Promise.all([plan.adopt("a", child(0)), plan.adopt("b", child(1))]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(base);
    cleanUp("child-0", "child-1");
  });

  it("steps over branches the repository already has, the draft's own included", async () => {
    registerJiraThreadStart({ ...registration, threadId: parent });
    const plan = planJiraFanout(parent, repository(base, `${base}-3`));
    const branches = await Promise.all([plan.adopt("a", child(0)), plan.adopt("b", child(1))]);
    expect(branches).toEqual([{ branch: `${base}-2` }, { branch: `${base}-4` }]);
    cleanUp("child-0", "child-1");
  });

  it("steps over names other unsent starts have claimed", async () => {
    registerJiraThreadStart({ ...registration, threadId: parent });
    registerJiraThreadStart({
      ...registration,
      threadId: ThreadId.make("other-draft"),
      branch: `${base}-2`,
    });
    const plan = planJiraFanout(parent, repository());
    const branches = await Promise.all([plan.adopt("a", child(0)), plan.adopt("b", child(1))]);
    expect(branches).toEqual([{ branch: base }, { branch: `${base}-3` }]);
    cleanUp("child-0", "child-1");
  });

  it("hands a retried child the name it had, and never the branch a sibling now holds", async () => {
    registerJiraThreadStart({ ...registration, threadId: parent });
    const first = planJiraFanout(parent, repository());
    await first.adopt("a", child(0));
    await first.adopt("b", child(1));
    // The first child started; the second did not. The repository has the first one's branch.
    const retry = planJiraFanout(parent, repository(base));
    expect(await retry.adopt("b", child(9))).toEqual({ branch: `${base}-2` });
    // One registration for the retried child, under the thread that is starting now.
    expect(jiraWorktreeBranchFor(child(1))).toEqual({});
    expect(jiraWorktreeBranchFor(child(9))).toEqual({ branch: `${base}-2` });
    expect(jiraWorktreeBranchFor(child(0))).toEqual({ branch: base });
    cleanUp("child-0", "child-1", "child-9");
  });

  it("moves a retried child on when its name was taken in the meantime", async () => {
    registerJiraThreadStart({ ...registration, threadId: parent });
    const first = planJiraFanout(parent, repository());
    await first.adopt("a", child(0));
    await first.adopt("b", child(1));
    const retry = planJiraFanout(parent, repository(base, `${base}-2`));
    expect(await retry.adopt("b", child(9))).toEqual({ branch: `${base}-3` });
    cleanUp("child-0", "child-1", "child-9");
  });

  it("still keeps clear of threads and unsent starts when the repository cannot be read", async () => {
    registerJiraThreadStart({ ...registration, threadId: parent });
    registerJiraThreadStart({
      ...registration,
      threadId: ThreadId.make("other-draft"),
      branch: base,
    });
    const plan = planJiraFanout(parent, () => Promise.reject(new Error("offline")));
    expect(await plan.adopt("a", child(0))).toEqual({ branch: `${base}-2` });
    cleanUp("child-0");
  });

  it("registers children of a draft that asked for no worktree without branches or a read", async () => {
    registerJiraThreadStart({ ...registration, threadId: parent, branch: null });
    const read = vi.fn(repository());
    const plan = planJiraFanout(parent, read);
    expect(await plan.adopt("a", child(1))).toEqual({});
    expect(jiraWorktreeBranchFor(child(1))).toEqual({});
    expect(read).not.toHaveBeenCalled();
    plan.finish();
    cleanUp("child-1");
  });
});
