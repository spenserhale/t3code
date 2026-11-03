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
  isSameHandoffCode,
  listHandoffSteps,
  planThreadMachineHandoff,
  resolveHandoffComparisonBase,
  resolveHandoffModelSelection,
  resolveHandoffPushed,
  type HandoffEnvironment,
  type HandoffMachineStatus,
  type HandoffReady,
  type HandoffThread,
} from "./threadMachineHandoff.ts";
import type { EnvironmentProject } from "./state/models.ts";
import type { HandoffGitStatus } from "@t3tools/shared/threadMachineHandoff";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const claude = ProviderInstanceId.make("claudeAgent");

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
    repositoryIdentity: { ...repositoryIdentity, rootPath: `/work/${id}` },
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
    canSourceControl: true,
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
    sourceAccess: { canOperate: true, canSourceControl: true },
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
  ) => assessHandoffMachines({ source: from, projects, environments });

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

  describe("picking the project on the machine", () => {
    const inRepository = (
      environmentId: EnvironmentId,
      id: string,
      relativePath: string,
      identity: Partial<NonNullable<EnvironmentProject["repositoryIdentity"]>> = {},
    ) =>
      project(environmentId, id, {
        workspaceRoot: relativePath === "" ? `/repo/${id}` : `/repo/${id}/${relativePath}`,
        repositoryIdentity: { ...repositoryIdentity, rootPath: `/repo/${id}`, ...identity },
      });
    const statusOn = (projects: ReadonlyArray<EnvironmentProject>, from: EnvironmentProject) =>
      assess([environment(server)], [from, ...projects], from)[0]?.status;

    it("matches the repository whatever the sidebar's grouping, and the project's place in it", () => {
      const app = inRepository(laptop, "app-here", "packages/app");
      const root = inRepository(server, "root", "");
      const otherApp = inRepository(server, "app-there", "packages/app");
      const lib = inRepository(server, "lib-there", "packages/lib");
      expect(statusOn([root, otherApp, lib], app)).toEqual({ kind: "ready", project: otherApp });
    });

    it("does not stand in the repository's root for a subproject it lacks", () => {
      const app = inRepository(laptop, "app-here", "packages/app");
      expect(statusOn([inRepository(server, "root", "")], app)).toEqual({
        kind: "needs-project",
        canAdd: true,
      });
    });

    it("asks which one when the machine has several checkouts in the same place", () => {
      const first = inRepository(server, "first", "");
      const second = inRepository(server, "second", "");
      expect(statusOn([first, second], source)).toEqual({
        kind: "choose",
        projects: [first, second],
      });
    });

    it("takes the only candidate when a path cannot be worked out", () => {
      const noRoot = project(server, "no-root", {
        repositoryIdentity: { ...repositoryIdentity },
      });
      expect(statusOn([noRoot], source)).toEqual({ kind: "ready", project: noRoot });
      expect(statusOn([noRoot, inRepository(server, "second", "")], source)?.kind).toBe("choose");
      expect(statusOn([noRoot, inRepository(server, "other", "packages/other")], source)).toEqual({
        kind: "ready",
        project: noRoot,
      });
    });

    it("looks for the repository the push goes to: a fork's own origin", () => {
      const fork = inRepository(laptop, "fork-here", "", {
        canonicalKey: "github.com/t3tools/t3code",
        origin: { canonicalKey: "github.com/me/t3code" },
      });
      const forkThere = inRepository(server, "fork-there", "", {
        canonicalKey: "github.com/me/t3code",
      });
      const upstreamThere = inRepository(server, "upstream-there", "");
      expect(statusOn([upstreamThere], fork)?.kind).toBe("needs-project");
      expect(statusOn([upstreamThere, forkThere], fork)).toEqual({
        kind: "ready",
        project: forkThere,
      });
    });
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

  it("waits for a project to be chosen when the machine has several", () => {
    const choose = { environment: environment(server), status: { kind: "choose", projects: [] } };
    expect(plan({ machine: choose as never })).toMatchObject({
      kind: "blocked",
      reason: "choose-project",
    });
  });

  it("needs the source's grants: to change the thread, and to commit and push", () => {
    expect(plan({ sourceAccess: { canOperate: false, canSourceControl: true } })).toMatchObject({
      kind: "blocked",
      reason: "source-read-only",
    });
    const changes = git({ hasWorkingTreeChanges: true, workingTree: { files: [{ path: "a" }] } });
    expect(
      plan({ git: changes, sourceAccess: { canOperate: true, canSourceControl: false } }),
    ).toMatchObject({ kind: "blocked", reason: "source-no-source-control" });
    const local = project(laptop, "local", { repositoryIdentity: null });
    expect(
      plan({
        source: local,
        machine: machineWith(null),
        git: null,
        sourceAccess: { canOperate: true, canSourceControl: false },
      }).kind,
    ).toBe("ready");
  });

  it("needs the target's grant to make a worktree, but only when code travels", () => {
    const noGrant = machineWith(targetCheckout, environment(server, { canSourceControl: false }));
    expect(plan({ machine: noGrant, git: git({ aheadCount: 1 }) })).toMatchObject({
      kind: "blocked",
      reason: "machine-no-source-control",
    });
    expect(plan({ machine: noGrant, git: git({ isRepo: false }) }).kind).toBe("ready");
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
      commit: { fileCount: 3, message: "WIP: hand off to Server", paths: ["a.ts", "b.ts", "c.ts"] },
      comparisonBase: "origin/main",
    });
    expect(result.target).toMatchObject({
      environmentId: server,
      label: "Server",
      cwd: "/work/target",
      identity: targetCheckout.repositoryIdentity,
    });
  });

  it("only pushes when everything is committed already", () => {
    expect(ready(plan({ git: git({ aheadCount: 2 }) })).code).toEqual({
      kind: "carry",
      branch: "feature/login",
      createBranch: false,
      commit: null,
      comparisonBase: "origin/main",
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
      commit: { fileCount: 1, message: "WIP: hand off to Server", paths: ["a.ts"] },
      comparisonBase: "origin/main",
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

  it("branches off whenever the default branch is unknown, whatever the branch is called", () => {
    const develop = git({ refName: "develop", defaultBranchKnown: false, aheadCount: 1 });
    expect(ready(plan({ git: develop })).code).toMatchObject({
      createBranch: true,
      branch: "handoff/fix-the-flaky-login-test",
    });
    const known = git({ refName: "develop", defaultBranchKnown: true, aheadCount: 1 });
    expect(ready(plan({ git: known })).code).toMatchObject({
      createBranch: false,
      branch: "develop",
    });
  });

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

  it("carries code through whichever remote the project has, origin or not", () => {
    const viaGithub = project(laptop, "source", {
      repositoryIdentity: {
        ...repositoryIdentity,
        locator: { ...repositoryIdentity.locator, remoteName: "github" },
      },
    });
    expect(ready(plan({ source: viaGithub, git: git({ aheadCount: 1 }) })).code.kind).toBe("carry");
  });

  it("hands over only the conversation when the checkout is not a repository", () => {
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

describe("resolveHandoffPushed", () => {
  const carry = ready(plan({ git: git({ aheadCount: 1 }) }));
  const withIdentities = (
    sourceIdentity: Partial<NonNullable<EnvironmentProject["repositoryIdentity"]>>,
    targetIdentity: Partial<NonNullable<EnvironmentProject["repositoryIdentity"]>>,
  ) =>
    ready(
      plan({
        source: project(laptop, "source", {
          repositoryIdentity: { ...repositoryIdentity, ...sourceIdentity },
        }),
        machine: machineWith(
          project(server, "target", {
            repositoryIdentity: { ...repositoryIdentity, ...targetIdentity },
          }),
        ),
        git: git({ aheadCount: 1 }),
      }),
    );
  const github = (remoteName: string) => ({
    locator: { ...repositoryIdentity.locator, remoteName },
  });

  it("continues the branch that was pushed, through the machine's own name for that remote", () => {
    expect(resolveHandoffPushed(carry, "origin/handoff/fix-login")).toEqual({
      ok: true,
      branch: "handoff/fix-login",
      sourceRemote: "origin",
      remote: "origin",
      remoteRef: "origin/handoff/fix-login",
    });
    const named = withIdentities(github("origin"), github("github"));
    expect(resolveHandoffPushed(named, "origin/feature/login")).toMatchObject({
      ok: true,
      remote: "github",
      remoteRef: "github/feature/login",
    });
  });

  it("follows a fork's own origin, on both sides", () => {
    const fork = {
      locator: { ...repositoryIdentity.locator, remoteName: "upstream" },
      origin: { canonicalKey: "github.com/me/t3code" },
    };
    const forkPlan = withIdentities(fork, {
      canonicalKey: "github.com/me/t3code",
      locator: { ...repositoryIdentity.locator, remoteName: "origin" },
    });
    expect(resolveHandoffPushed(forkPlan, "origin/feature")).toMatchObject({
      ok: true,
      remote: "origin",
    });
    // The upstream remote is the other repository: the machine's origin is not it.
    expect(resolveHandoffPushed(forkPlan, "upstream/feature")).toMatchObject({ ok: false });
  });

  it("refuses a remote it cannot match to the machine's repository", () => {
    const result = resolveHandoffPushed(carry, "publish/feature");
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toContain("publish");
    const elsewhere = withIdentities({}, { canonicalKey: "github.com/other/repo" });
    expect(resolveHandoffPushed(elsewhere, "origin/feature")).toMatchObject({ ok: false });
  });

  it("has no branch when nothing was pushed or no code was planned", () => {
    expect(resolveHandoffPushed(carry, undefined)).toMatchObject({ ok: false });
    expect(resolveHandoffPushed(carry, "origin/")).toMatchObject({ ok: false });
    const none = ready(plan({ git: git({ isRepo: false }) }));
    expect(resolveHandoffPushed(none, "origin/main")).toMatchObject({ ok: false });
  });
});

describe("resolveHandoffComparisonBase", () => {
  const pushed = {
    ok: true,
    branch: "b",
    sourceRemote: "origin",
    remote: "github",
    remoteRef: "github/b",
  } as const;

  it("renames the remote in the base the way the target machine knows it", () => {
    expect(resolveHandoffComparisonBase("origin/main", pushed)).toBe("github/main");
    expect(resolveHandoffComparisonBase("main", pushed)).toBe("main");
    expect(resolveHandoffComparisonBase(null, pushed)).toBeNull();
  });
});

describe("isSameHandoffCode", () => {
  const code = (overrides: Partial<Parameters<typeof git>[0]> = {}) =>
    ready(plan({ git: git({ aheadCount: 1, ...overrides }) })).code;

  it("is the same work when the branch, the new branch and the changed files are", () => {
    expect(isSameHandoffCode(code(), code())).toBe(true);
    const changed = { hasWorkingTreeChanges: true, workingTree: { files: [{ path: "a" }] } };
    expect(isSameHandoffCode(code(changed), code(changed))).toBe(true);
  });

  it("is not when the set of changed files is not the one that was confirmed", () => {
    const files = (...paths: ReadonlyArray<string>) => ({
      hasWorkingTreeChanges: true,
      workingTree: { files: paths.map((path) => ({ path })) },
    });
    const confirmed = code(files("a.ts"));
    expect(isSameHandoffCode(confirmed, code(files("a.ts")))).toBe(true);
    const twenty = Array.from({ length: 20 }, (_, index) => `file-${index}.ts`);
    expect(isSameHandoffCode(confirmed, code(files("a.ts", ...twenty)))).toBe(false);
    expect(isSameHandoffCode(confirmed, code(files("b.ts")))).toBe(false);
    expect(isSameHandoffCode(code(files("a.ts", "b.ts")), code(files("b.ts", "a.ts")))).toBe(true);
  });

  it("is not when the checkout moved to another branch or its changes appeared or went", () => {
    expect(isSameHandoffCode(code(), code({ refName: "other" }))).toBe(false);
    expect(isSameHandoffCode(code(), code({ refName: "main", isDefaultRef: true }))).toBe(false);
    expect(
      isSameHandoffCode(
        code(),
        code({ hasWorkingTreeChanges: true, workingTree: { files: [{ path: "a" }] } }),
      ),
    ).toBe(false);
    expect(isSameHandoffCode(code(), { kind: "none", reason: "scratch" })).toBe(false);
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
    ).toEqual(["conversation", "branch", "commit", "push", "fetch", "worktree", "draft"]);
  });

  it("skips the commit when everything is committed, and the branch when it exists", () => {
    expect(steps({ git: git({ aheadCount: 1 }) })).toEqual([
      "conversation",
      "push",
      "fetch",
      "worktree",
      "draft",
    ]);
  });

  it("is only the draft when no code travels and the machine takes no files", () => {
    const machine = machineWith(targetCheckout, environment(server, { maxFileBytes: null }));
    expect(steps({ machine, git: git({ isRepo: false }) })).toEqual(["draft"]);
  });
});
