import { describe, expect, it } from "vite-plus/test";

import {
  buildHandoffNote,
  collectHandoffBranchNames,
  explainHandoffGitFailure,
  handoffCommitMessage,
  pickHandoffBranchName,
  planHandoffCode,
  type HandoffCodePlan,
  type HandoffGitStatus,
} from "./threadMachineHandoff.ts";

function git(overrides: Partial<HandoffGitStatus> = {}): HandoffGitStatus {
  return {
    isRepo: true,
    refName: "feature/login",
    isDefaultRef: false,
    defaultBranchKnown: true,
    hasWorkingTreeChanges: false,
    workingTree: { files: [] },
    hasUpstream: true,
    aheadCount: 0,
    branchChanges: { baseRef: "origin/main" },
    ...overrides,
  };
}

describe("planHandoffCode", () => {
  const plan = (status: Partial<HandoffGitStatus>, existingBranchNames: string[] = []) =>
    planHandoffCode({
      title: "Fix the flaky login test",
      machineLabel: "Server",
      git: git(status),
      existingBranchNames,
    });

  it("commits the changes on a branch that is not the default and pushes it as it is", () => {
    expect(
      plan({ hasWorkingTreeChanges: true, workingTree: { files: [{ path: "b" }, { path: "a" }] } }),
    ).toEqual({
      code: {
        kind: "carry",
        branch: "feature/login",
        createBranch: false,
        commit: { fileCount: 2, message: "WIP: hand off to Server", paths: ["a", "b"] },
        comparisonBase: "origin/main",
      },
    });
  });

  it.each([
    ["the default branch", { isDefaultRef: true }],
    ["main by name", { refName: "main", isDefaultRef: false }],
    ["any branch of a repository that does not name its default", { defaultBranchKnown: false }],
  ])("moves work on %s to a new handoff branch", (_name, status) => {
    expect(plan({ ...status, aheadCount: 1 }, ["handoff/fix-the-flaky-login-test"])).toMatchObject({
      code: {
        kind: "carry",
        branch: "handoff/fix-the-flaky-login-test-2",
        createBranch: true,
        commit: null,
      },
    });
  });

  it("needs a branch to push", () => {
    expect(plan({ refName: null })).toMatchObject({ kind: "blocked", reason: "detached-head" });
  });

  it("carries nothing it has no work or upstream for", () => {
    expect(plan({ isDefaultRef: true })).toEqual({
      code: { kind: "none", reason: "nothing-to-carry" },
    });
    expect(plan({ hasUpstream: false })).toEqual({
      code: { kind: "none", reason: "nothing-to-carry" },
    });
    expect(plan({ isRepo: false })).toEqual({ code: { kind: "none", reason: "not-a-repo" } });
  });
});

describe("pickHandoffBranchName", () => {
  it("slugs the title under handoff/", () => {
    expect(pickHandoffBranchName("Fix: the flaky   login test!", [])).toBe(
      "handoff/fix-the-flaky-login-test",
    );
    expect(pickHandoffBranchName("日本語", [])).toBe("handoff/update");
  });

  it("steps past names taken locally or on the remote, whatever their case", () => {
    expect(pickHandoffBranchName("Fix login", ["Handoff/fix-login", "handoff/fix-login-2"])).toBe(
      "handoff/fix-login-3",
    );
  });

  it("steps aside for a branch named handoff", () => {
    expect(pickHandoffBranchName("Fix login", ["handoff"])).toBe("handoff-2/fix-login");
  });
});

describe("handoffCommitMessage", () => {
  it("names the machine on one line", () => {
    expect(handoffCommitMessage("  Link\nPro  ")).toBe("WIP: hand off to Link Pro");
  });
});

describe("collectHandoffBranchNames", () => {
  it("lists local names and the remote ones without their remote", () => {
    expect(
      collectHandoffBranchNames([
        { name: "handoff" },
        { name: "origin/handoff-2/x", isRemote: true, remoteName: "origin" },
        { name: "team/handoff/y", isRemote: true, remoteName: "team" },
      ]),
    ).toEqual(["handoff", "handoff-2/x", "handoff/y"]);
  });

  it("makes the picker step aside for a branch named handoff, wherever it was listed", () => {
    const names = collectHandoffBranchNames([{ name: "handoff" }]);
    expect(pickHandoffBranchName("Fix login", names)).toBe("handoff-2/fix-login");
  });
});

describe("buildHandoffNote", () => {
  const carry = {
    kind: "carry",
    branch: "feature/login",
    createBranch: false,
    commit: { fileCount: 1, message: "WIP: hand off to Server", paths: ["a"] },
    comparisonBase: "origin/main",
  } satisfies HandoffCodePlan;
  const base = {
    title: "Fix the flaky login test",
    sourceLabel: "Laptop",
    code: carry as HandoffCodePlan,
    remoteRef: "origin/feature/login",
    threadLink: "<t3-thread://v2/laptop/thread-1>",
    transcriptAttached: true,
  };

  it("names the thread, the machine, the branch, the link and the attachment", () => {
    expect(buildHandoffNote(base)).toBe(
      [
        'Continuing "Fix the flaky login test", handed off from Laptop.',
        "",
        "- The worktree continues `feature/login`, which tracks `origin/feature/login` and includes a WIP commit of the uncommitted changes.",
        "- Source thread: <t3-thread://v2/laptop/thread-1>",
        "- The conversation so far is attached for reference.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("leaves out the WIP commit when there was none, and the link when there is none", () => {
    const note = buildHandoffNote({
      ...base,
      code: { ...carry, commit: null },
      threadLink: null,
    });
    expect(note).toContain(
      "- The worktree continues `feature/login`, which tracks `origin/feature/login`.",
    );
    expect(note).not.toContain("Source thread");
  });

  it("says why no code came along", () => {
    expect(
      buildHandoffNote({
        ...base,
        code: { kind: "none", reason: "no-remote" },
        remoteRef: null,
      }),
    ).toContain("- No code was carried over: the project has no git remote.");
    expect(buildHandoffNote({ ...base, remoteRef: null })).toContain(
      "No code was carried over: the branch has no changes to carry.",
    );
  });

  it("says when the conversation could not be attached", () => {
    expect(buildHandoffNote({ ...base, transcriptAttached: false })).toContain(
      "could not be attached",
    );
  });

  it("tidies a title that is blank, multi-line or long", () => {
    expect(buildHandoffNote({ ...base, title: "  \n " })).toContain('"Untitled thread"');
    expect(buildHandoffNote({ ...base, title: "a\n\nb" })).toContain('"a b"');
    expect(buildHandoffNote({ ...base, title: "x".repeat(300) })).toContain(`"${"x".repeat(120)}"`);
  });
});

describe("explainHandoffGitFailure", () => {
  it.each([
    ["authentication_failed", "could not sign in"],
    ["push_rejected_non_fast_forward", "Pull them"],
    ["push_rejected_by_remote", "refused the push"],
    ["remote_unreachable", "could not reach"],
    ["host_key_unverified", "host key"],
  ])("explains %s", (reason, text) => {
    expect(
      explainHandoffGitFailure(
        `Git command failed in GitVcsDriver.pushCurrentBranch (/work): fatal: nope (${reason})`,
      ),
    ).toContain(text);
  });

  it("passes any other message through", () => {
    expect(explainHandoffGitFailure("pre-commit hook failed")).toBe("pre-commit hook failed");
    expect(explainHandoffGitFailure("failed (something_new)")).toBe("failed (something_new)");
  });
});
