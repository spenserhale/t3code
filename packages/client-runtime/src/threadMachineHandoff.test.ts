import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assessHandoffMachines,
  buildHandoffNote,
  explainHandoffGitFailure,
  handoffCommitMessage,
  listHandoffSteps,
  pickHandoffBranchName,
  planThreadMachineHandoff,
  resolveHandoffDraftBase,
  resolveHandoffModelSelection,
  type HandoffEnvironment,
  type HandoffGitStatus,
  type HandoffMachineStatus,
  type HandoffReady,
  type HandoffThread,
} from "./threadMachineHandoff.ts";
import type { EnvironmentProject } from "./state/models.ts";
import type { ProjectGroupingSettings } from "./state/projectGrouping.ts";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const claude = ProviderInstanceId.make("claudeAgent");

const settings: ProjectGroupingSettings = {
  sidebarProjectGroupingMode: "repository",
  sidebarProjectGroupingOverrides: {},
};

const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: SourceControlProviderKind.make("github"),
};

function project(
  environmentId: EnvironmentId,
  id: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function providerOf(overrides: Record<string, unknown> = {}): ServerProvider {
  return {
    instanceId: claude,
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    models: [{ slug: "claude-opus", name: "Opus", isCustom: false, capabilities: null }],
    ...overrides,
  } as unknown as ServerProvider;
}

function environment(
  environmentId: EnvironmentId,
  overrides: Partial<HandoffEnvironment> = {},
): HandoffEnvironment {
  return {
    environmentId,
    label: environmentId === laptop ? "Laptop" : "Server",
    connected: true,
    canOperate: true,
    canAddProject: true,
    scratchAvailable: true,
    providers: [providerOf()],
    maxFileBytes: 10_000_000,
    ...overrides,
  };
}

const thread: HandoffThread = {
  title: "Fix the flaky login test",
  modelSelection: { instanceId: claude, model: "claude-opus" },
  runStatus: "completed",
  hasPendingApproval: false,
};

const source = project(laptop, "source");
const targetCheckout = project(server, "target");

function git(overrides: Partial<HandoffGitStatus> = {}): HandoffGitStatus {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    refName: "feature/login",
    isDefaultRef: false,
    hasWorkingTreeChanges: false,
    workingTree: { files: [] },
    hasUpstream: true,
    aheadCount: 0,
    ...overrides,
  };
}

function machineWith(project: EnvironmentProject | null, env = environment(server)) {
  return { environment: env, status: { kind: "ready", project } } as const;
}

function plan(overrides: Partial<Parameters<typeof planThreadMachineHandoff>[0]> = {}) {
  return planThreadMachineHandoff({
    thread,
    source,
    machine: machineWith(targetCheckout),
    git: git(),
    existingBranchNames: [],
    ...overrides,
  });
}

function ready(result: ReturnType<typeof plan>): HandoffReady {
  if (result.kind !== "ready") throw new Error(`blocked: ${result.reason}`);
  return result;
}

describe("assessHandoffMachines", () => {
  const assess = (
    environments: ReadonlyArray<HandoffEnvironment>,
    projects: ReadonlyArray<EnvironmentProject>,
    from: EnvironmentProject = source,
  ) => assessHandoffMachines({ source: from, projects, settings, environments });

  it("finds the other machine's checkout of the same repository and skips the source's own machine", () => {
    const result = assess(
      [environment(laptop), environment(server)],
      [source, targetCheckout, project(server, "unrelated", { repositoryIdentity: null })],
    );
    expect(result.map((machine) => machine.environment.environmentId)).toEqual([server]);
    expect(result[0]?.status).toEqual({ kind: "ready", project: targetCheckout });
  });

  it("asks for the project when the machine has none, and whether it can clone one", () => {
    expect(assess([environment(server)], [source])[0]?.status).toEqual({
      kind: "needs-project",
      canAdd: true,
    });
    expect(assess([environment(server, { canAddProject: false })], [source])[0]?.status).toEqual({
      kind: "needs-project",
      canAdd: false,
    });
  });

  it("does not count an archived checkout", () => {
    const archived = project(server, "target", { archivedAt: "2026-08-01T00:00:00.000Z" });
    expect(assess([environment(server)], [source, archived])[0]?.status.kind).toBe("needs-project");
  });

  it("reports an offline or read-only machine before looking for the project", () => {
    expect(
      assess([environment(server, { connected: false })], [source, targetCheckout])[0]?.status,
    ).toEqual({ kind: "unavailable", reason: "offline" });
    expect(
      assess([environment(server, { canOperate: false })], [source, targetCheckout])[0]?.status,
    ).toEqual({ kind: "unavailable", reason: "read-only" });
  });

  it("sends a project without a git remote to the machine's project-less folder", () => {
    const local = project(laptop, "local", { repositoryIdentity: null });
    expect(assess([environment(server)], [local], local)[0]?.status).toEqual({
      kind: "ready",
      project: null,
    });
    expect(
      assess([environment(server, { scratchAvailable: false })], [local], local)[0]?.status,
    ).toEqual({ kind: "unavailable", reason: "no-folder" });
  });
});

describe("planThreadMachineHandoff", () => {
  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "waits for a thread that is %s",
    (runStatus) => {
      expect(plan({ thread: { ...thread, runStatus } })).toMatchObject({
        kind: "blocked",
        reason: "thread-running",
      });
    },
  );

  it.each([null, "idle", "completed", "failed", "interrupted", "cancelled"] as const)(
    "lets a thread that is %s go",
    (runStatus) => {
      expect(plan({ thread: { ...thread, runStatus } }).kind).toBe("ready");
    },
  );

  it("waits for an approval to be answered", () => {
    expect(plan({ thread: { ...thread, hasPendingApproval: true } })).toMatchObject({
      kind: "blocked",
      reason: "thread-waiting",
    });
  });

  it("explains a machine that cannot take the thread", () => {
    const blocked = (status: HandoffMachineStatus) =>
      plan({ machine: { environment: environment(server), status } });
    expect(blocked({ kind: "unavailable", reason: "offline" })).toMatchObject({
      reason: "machine-offline",
      message: "Server is not connected.",
    });
    expect(blocked({ kind: "unavailable", reason: "read-only" })).toMatchObject({
      reason: "machine-read-only",
    });
    expect(blocked({ kind: "needs-project", canAdd: true })).toMatchObject({
      reason: "needs-project",
    });
  });

  it("waits for the checkout's status", () => {
    expect(plan({ git: null })).toMatchObject({ kind: "blocked", reason: "git-loading" });
  });

  it("commits the changes on the thread's own branch and pushes it", () => {
    const result = ready(
      plan({
        git: git({
          hasWorkingTreeChanges: true,
          workingTree: { files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] },
          aheadCount: 1,
        }),
      }),
    );
    expect(result.code).toEqual({
      kind: "carry",
      branch: "feature/login",
      createBranch: false,
      commit: { fileCount: 3, message: "WIP: hand off to Server" },
    });
    expect(result.target).toMatchObject({
      environmentId: server,
      label: "Server",
      remoteName: "origin",
    });
  });

  it("only pushes when everything is committed already", () => {
    expect(ready(plan({ git: git({ aheadCount: 2 }) })).code).toEqual({
      kind: "carry",
      branch: "feature/login",
      createBranch: false,
      commit: null,
    });
  });

  it("moves default-branch work to a new handoff branch named after the thread", () => {
    const onDefault = git({
      refName: "main",
      isDefaultRef: true,
      hasWorkingTreeChanges: true,
      workingTree: { files: [{ path: "a.ts" }] },
    });
    const code = ready(plan({ git: onDefault })).code;
    expect(code).toEqual({
      kind: "carry",
      branch: "handoff/fix-the-flaky-login-test",
      createBranch: true,
      commit: { fileCount: 1, message: "WIP: hand off to Server" },
    });
    expect(
      ready(
        plan({
          git: onDefault,
          existingBranchNames: ["handoff/fix-the-flaky-login-test", "main"],
        }),
      ).code,
    ).toMatchObject({ branch: "handoff/fix-the-flaky-login-test-2" });
  });

  it("branches default-branch commits that were never pushed, without a commit of its own", () => {
    expect(
      ready(plan({ git: git({ refName: "main", isDefaultRef: true, aheadCount: 2 }) })).code,
    ).toMatchObject({ createBranch: true, commit: null });
  });

  it.each(["main", "master"])(
    "treats %s as the default branch even when the server could not tell",
    (refName) => {
      expect(
        ready(plan({ git: git({ refName, isDefaultRef: false, aheadCount: 1 }) })).code,
      ).toMatchObject({ createBranch: true });
    },
  );

  it("carries nothing from a default branch that has no work on it", () => {
    expect(ready(plan({ git: git({ refName: "main", isDefaultRef: true }) })).code).toEqual({
      kind: "none",
      reason: "nothing-to-carry",
    });
  });

  it("carries nothing from an unpublished branch with no work on it", () => {
    expect(ready(plan({ git: git({ hasUpstream: false }) })).code).toEqual({
      kind: "none",
      reason: "nothing-to-carry",
    });
  });

  it("needs a branch", () => {
    expect(plan({ git: git({ refName: null }) })).toMatchObject({
      kind: "blocked",
      reason: "detached-head",
    });
  });

  it("hands over only the conversation when there is no remote to carry code through", () => {
    expect(ready(plan({ git: git({ hasPrimaryRemote: false }) })).code).toEqual({
      kind: "none",
      reason: "no-remote",
    });
    expect(ready(plan({ git: git({ isRepo: false }) })).code).toEqual({
      kind: "none",
      reason: "not-a-repo",
    });
  });

  it("needs no git status for a project that carries no code", () => {
    const local = project(laptop, "local", { repositoryIdentity: null });
    const result = ready(
      plan({ source: local, machine: machineWith(null), git: null, existingBranchNames: [] }),
    );
    expect(result.code).toEqual({ kind: "none", reason: "no-remote" });
    expect(result.target.project).toBeNull();
    const scratch = project(laptop, "scratch", { isScratch: true });
    expect(ready(plan({ source: scratch, machine: machineWith(null), git: null })).code).toEqual({
      kind: "none",
      reason: "scratch",
    });
  });

  it("names the remote the way the machine's project locates its repository", () => {
    const viaUpstream = project(server, "target", {
      repositoryIdentity: {
        ...repositoryIdentity,
        locator: { ...repositoryIdentity.locator, remoteName: "github" },
      },
    });
    expect(ready(plan({ machine: machineWith(viaUpstream) })).target.remoteName).toBe("github");
    const fork = project(server, "target", {
      repositoryIdentity: {
        ...repositoryIdentity,
        locator: { ...repositoryIdentity.locator, remoteName: "upstream" },
        origin: { canonicalKey: "github.com/me/t3code" },
      },
    });
    expect(ready(plan({ machine: machineWith(fork) })).target.remoteName).toBe("origin");
  });

  it("attaches the conversation only where files are accepted", () => {
    expect(ready(plan()).transcript).toEqual({ attach: true, maxBytes: 10_000_000 });
    const noFiles = machineWith(targetCheckout, environment(server, { maxFileBytes: null }));
    expect(ready(plan({ machine: noFiles })).transcript).toEqual({
      attach: false,
      maxBytes: null,
    });
  });
});

describe("resolveHandoffModelSelection", () => {
  const selection = {
    instanceId: claude,
    model: "claude-opus",
    options: [{ id: "effort", value: "high" }],
  };

  it("keeps the model and its options where the machine has them", () => {
    expect(resolveHandoffModelSelection(selection, [providerOf()])).toEqual(selection);
  });

  it("recognises the model by name too", () => {
    expect(
      resolveHandoffModelSelection({ ...selection, model: "opus" }, [providerOf()]),
    ).toMatchObject({ model: "claude-opus" });
  });

  it.each([
    ["no such provider", []],
    ["a disabled provider", [providerOf({ enabled: false })]],
    ["a provider that is not installed", [providerOf({ installed: false })]],
    ["an unavailable provider", [providerOf({ availability: "unavailable" })]],
    ["a provider in error", [providerOf({ status: "error" })]],
    ["a model it does not list", [providerOf({ models: [] })]],
  ])("leaves the machine to choose with %s", (_name, providers) => {
    expect(resolveHandoffModelSelection(selection, providers)).toBeNull();
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

describe("resolveHandoffDraftBase", () => {
  const carry = ready(plan({ git: git({ aheadCount: 1 }) }));

  it("bases the worktree on the branch that was pushed, through the machine's own remote", () => {
    expect(resolveHandoffDraftBase(carry, "origin/handoff/fix-login")).toBe(
      "origin/handoff/fix-login",
    );
    const github = {
      ...carry,
      target: { ...carry.target, remoteName: "github" },
    };
    expect(resolveHandoffDraftBase(github, "origin/handoff/fix-login")).toBe(
      "github/handoff/fix-login",
    );
  });

  it("has no base when nothing was pushed or no code was planned", () => {
    expect(resolveHandoffDraftBase(carry, undefined)).toBeNull();
    expect(resolveHandoffDraftBase(carry, "origin/")).toBeNull();
    const none = ready(plan({ git: git({ hasPrimaryRemote: false }) }));
    expect(resolveHandoffDraftBase(none, "origin/main")).toBeNull();
  });
});

describe("buildHandoffNote", () => {
  const carry = ready(plan({ git: git({ hasWorkingTreeChanges: true, aheadCount: 1 }) })).code;
  const base = {
    title: "Fix the flaky login test",
    sourceLabel: "Laptop",
    code: carry,
    pushedBase: "origin/feature/login",
    threadLink: "https://app.t3.codes/laptop/thread-1",
    transcriptAttached: true,
  };

  it("names the thread, the machine, the branch, the link and the attachment", () => {
    expect(buildHandoffNote(base)).toBe(
      [
        'Continuing "Fix the flaky login test", handed off from Laptop.',
        "",
        "- The worktree starts from `origin/feature/login`, which includes a WIP commit of the uncommitted changes.",
        "- Source thread: https://app.t3.codes/laptop/thread-1",
        "- The conversation so far is attached for reference.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("leaves out the WIP commit when there was none, and the link when there is none", () => {
    const note = buildHandoffNote({
      ...base,
      code: { ...base.code, commit: null } as typeof carry,
      threadLink: null,
    });
    expect(note).toContain("- The worktree starts from `origin/feature/login`.");
    expect(note).not.toContain("Source thread");
  });

  it("says why no code came along", () => {
    expect(
      buildHandoffNote({
        ...base,
        code: { kind: "none", reason: "no-remote" },
        pushedBase: null,
      }),
    ).toContain("- No code was carried over: the project has no git remote.");
    expect(buildHandoffNote({ ...base, pushedBase: null })).toContain(
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

describe("listHandoffSteps", () => {
  const steps = (overrides: Parameters<typeof plan>[0] = {}) =>
    listHandoffSteps(ready(plan(overrides)));

  it("lists everything a handoff from the default branch does, in order", () => {
    expect(
      steps({
        git: git({
          refName: "main",
          isDefaultRef: true,
          hasWorkingTreeChanges: true,
          workingTree: { files: [{ path: "a.ts" }] },
        }),
      }),
    ).toEqual(["conversation", "branch", "commit", "push", "draft"]);
  });

  it("skips the commit when everything is committed, and the branch when it exists", () => {
    expect(steps({ git: git({ aheadCount: 1 }) })).toEqual(["conversation", "push", "draft"]);
  });

  it("is only the draft when no code travels and the machine takes no files", () => {
    const machine = machineWith(targetCheckout, environment(server, { maxFileBytes: null }));
    expect(steps({ machine, git: git({ hasPrimaryRemote: false }) })).toEqual(["draft"]);
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
