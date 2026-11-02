import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forgetJiraThreadStart,
  jiraWorktreeBranchFor,
  nextStepForThreadStart,
  registerJiraThreadStart,
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
