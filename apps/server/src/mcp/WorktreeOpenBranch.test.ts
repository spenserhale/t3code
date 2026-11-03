import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type OrchestratorMcpFailure,
  type Project,
  type VcsRef,
  type WorktreeOpenBranchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpCapability, McpInvocationScope } from "./McpInvocationContext.ts";
import * as WorktreeOpenBranch from "./WorktreeOpenBranch.ts";

const projectId = ProjectId.make("project:app");
const root = "/work/app";
const tip = "a".repeat(40);
const older = "b".repeat(40);
const newer = "c".repeat(40);

const project = {
  id: projectId,
  title: "app",
  workspaceRoot: root,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
} as Project;

const scopeWith = (capabilities: ReadonlyArray<McpCapability>): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-box"),
  requestNamespace: "provider-session-box",
  thread: undefined,
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

interface Checkout {
  readonly branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  base: string | null;
  upstream: string;
}

/** A repository with one remote branch, `origin/feature`, at `tip`, and whatever a test adds. */
const makeRepository = (
  options: {
    readonly remotes?: Record<string, string>;
    readonly remoteBranch?: boolean;
    readonly holds?: ReadonlyArray<string>;
  } = {},
) => {
  const state = {
    remotes: options.remotes ?? { origin: "git@github.com:acme/app.git" },
    /** Local branches: where each is checked out, if anywhere, and what it tracks. */
    branches: new Map<string, { worktreePath: string | null; upstream: string | null }>(),
    /** The checkouts git knows, by path. */
    checkouts: new Map<string, Checkout>(),
    /** What the remote branch is at; absent when it is not on the remote. */
    remoteBranch: options.remoteBranch === false ? null : tip,
    /** The commits every checkout holds: what `merge-base --is-ancestor` finds. */
    holds: new Set(options.holds ?? [tip]),
    knownRefs: new Set<string>(["origin/main", "main"]),
    /** How far behind the remote a checkout git makes for a branch that exists already is. */
    behindOnCreate: 0,
    /** How many commits of its own a checkout git makes for a branch that exists already has. */
    aheadOnCreate: 0,
    log: [] as string[],
  };
  return state;
};
type Repository = ReturnType<typeof makeRepository>;

const failureOf = <A>(effect: Effect.Effect<A, OrchestratorMcpFailure>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

const makeService = (repo: Repository) => {
  let made = 0;
  const gitWorkflow = Layer.mock(GitWorkflowService.GitWorkflowService)({
    isRepository: () => Effect.succeed(true),
    remoteExists: ({ remoteName }) => Effect.succeed(remoteName in repo.remotes),
    fetchWorktreeBaseCommit: ({ refName }) => {
      repo.log.push(`fetch ${refName}`);
      return Effect.succeed(
        refName.endsWith("/feature") && repo.remoteBranch !== null
          ? { commitSha: repo.remoteBranch, remoteRefName: refName }
          : null,
      );
    },
    listRefs: () =>
      Effect.succeed({
        refs: [...repo.branches].map(([name, branch]): VcsRef => ({
          name,
          current: false,
          isDefault: false,
          worktreePath: branch.worktreePath,
          ...(branch.upstream === null ? {} : { upstreamRef: branch.upstream }),
        })),
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: repo.branches.size,
      }),
    createWorktree: (input) => {
      repo.log.push(`worktree ${input.newRefName ?? input.refName} from ${input.refName}`);
      made += 1;
      const path = `/worktrees/app-${made}`;
      const name = input.newRefName ?? input.refName;
      const existing = repo.branches.get(name);
      repo.branches.set(name, {
        worktreePath: path,
        upstream:
          input.newRefName === undefined
            ? (existing?.upstream ?? null)
            : `refs/remotes/${input.refName}`,
      });
      repo.checkouts.set(path, {
        branch: name,
        dirty: false,
        ahead: input.newRefName === undefined ? repo.aheadOnCreate : 0,
        behind: input.newRefName === undefined ? repo.behindOnCreate : 0,
        base: input.baseRefName ?? (input.newRefName === undefined ? "origin/main" : null),
        upstream: input.newRefName === undefined ? "origin/feature" : input.refName,
      });
      return Effect.succeed({ worktree: { path, refName: name } });
    },
    removeWorktree: ({ path }) => {
      repo.log.push(`remove ${path}`);
      const checkout = repo.checkouts.get(path);
      repo.checkouts.delete(path);
      const branch = checkout === undefined ? undefined : repo.branches.get(checkout.branch);
      if (checkout !== undefined && branch !== undefined) {
        repo.branches.set(checkout.branch, { ...branch, worktreePath: null });
      }
      return Effect.void;
    },
    deleteLocalBranch: ({ refName }) => {
      repo.log.push(`delete ${refName}`);
      repo.branches.delete(refName);
      return Effect.void;
    },
  });
  const git = Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: ({ args }) => {
      const text = args.join(" ");
      const done = (exitCode: number, stdout = "") =>
        Effect.succeed({
          exitCode,
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        } as GitVcsDriver.ExecuteGitResult);
      if (text === "remote -v") {
        return done(
          0,
          Object.entries(repo.remotes)
            .map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)`)
            .join("\n"),
        );
      }
      if (args[0] === "rev-parse") {
        return done(repo.knownRefs.has(args[3]!.replace(/\^\{commit\}$/, "")) ? 0 : 1);
      }
      if (args[0] === "merge-base") return done(repo.holds.has(args[2]!) ? 0 : 1);
      if (args[0] === "merge") {
        repo.log.push(`fast-forward to ${args[2]}`);
        return done(0);
      }
      return done(0);
    },
    statusDetailsLocal: (path) => {
      const checkout = repo.checkouts.get(path)!;
      return Effect.succeed({
        hasWorkingTreeChanges: checkout.dirty,
        aheadCount: checkout.ahead,
        behindCount: checkout.behind,
        upstreamRef: checkout.upstream,
        ...(checkout.base === null
          ? {}
          : { branchChanges: { baseRef: checkout.base, insertions: 0, deletions: 0 } }),
      } as GitVcsDriver.GitStatusDetails);
    },
    resolveCommit: () => Effect.succeed({ commitSha: repo.remoteBranch ?? older }),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  });
  return WorktreeOpenBranch.WorktreeOpenBranch.pipe(
    Effect.provide(
      WorktreeOpenBranch.layer.pipe(Layer.provide(Layer.mergeAll(gitWorkflow, git, projects))),
    ),
  );
};

const open = (
  repo: Repository,
  input: Partial<WorktreeOpenBranchInput> = {},
  capabilities: ReadonlyArray<McpCapability> = ["orchestration", "worktree"],
) =>
  Effect.gen(function* () {
    const service = yield* makeService(repo);
    return yield* service.open(scopeWith(capabilities), {
      projectId,
      branch: "feature",
      ...input,
    });
  });

/** A local branch that tracks the remote one, checked out in `worktreePath` when it has one. */
const trackingBranch = (repo: Repository, worktreePath: string | null) => {
  repo.branches.set("feature", { worktreePath, upstream: "refs/remotes/origin/feature" });
  if (worktreePath !== null) {
    repo.checkouts.set(worktreePath, {
      branch: "feature",
      dirty: false,
      ahead: 0,
      behind: 0,
      base: "origin/main",
      upstream: "origin/feature",
    });
  }
};

describe("t3_worktree_open_branch", () => {
  it.effect("makes a worktree on a new local branch that tracks the remote one", () =>
    Effect.gen(function* () {
      const repo = makeRepository();
      const opened = yield* open(repo, { baseRef: "origin/main", expectCommit: tip });
      expect(opened).toEqual({
        worktreePath: "/worktrees/app-1",
        branch: "feature",
        remote: "origin",
        head: tip,
        created: true,
      });
      expect(repo.log).toEqual(["fetch origin/feature", "worktree feature from origin/feature"]);
      expect(repo.checkouts.get("/worktrees/app-1")).toMatchObject({
        upstream: "origin/feature",
        base: "origin/main",
      });
    }),
  );

  it.effect("uses the remote that is the repository, whatever it is called", () =>
    Effect.gen(function* () {
      const repo = makeRepository({
        remotes: { origin: "git@github.com:fork/app.git", team: "git@github.com:acme/app.git" },
      });
      const opened = yield* open(repo, { repositoryKey: "github.com/acme/app" });
      expect(opened.remote).toBe("team");
      expect(repo.log).toContain("fetch team/feature");
    }),
  );

  it.effect("stops when no remote is the repository the branch was pushed to", () =>
    Effect.gen(function* () {
      const repo = makeRepository();
      const message = yield* failureOf(open(repo, { repositoryKey: "github.com/other/app" }));
      expect(message).toContain("No remote of this project here is github.com/other/app");
      expect(repo.log).toEqual([]);
    }),
  );

  it.effect("stops before making anything when the branch is not on the remote", () =>
    Effect.gen(function* () {
      const repo = makeRepository({ remoteBranch: false });
      const message = yield* failureOf(open(repo));
      expect(message).toContain("origin has no branch feature");
      expect(repo.log).toEqual(["fetch origin/feature"]);
    }),
  );

  it.effect("stops before making anything when the comparison base is not here", () =>
    Effect.gen(function* () {
      const repo = makeRepository();
      const message = yield* failureOf(open(repo, { baseRef: "origin/release" }));
      expect(message).toContain("does not have origin/release");
      expect(repo.log).toEqual(["fetch origin/feature"]);
    }),
  );

  it.effect("reuses a clean worktree that has the branch, and fast-forwards it", () =>
    Effect.gen(function* () {
      const repo = makeRepository();
      trackingBranch(repo, "/worktrees/earlier");
      repo.checkouts.get("/worktrees/earlier")!.behind = 2;
      const opened = yield* open(repo, { baseRef: "origin/main", expectCommit: tip });
      expect(opened).toMatchObject({ worktreePath: "/worktrees/earlier", created: false });
      expect(repo.log).toEqual(["fetch origin/feature", `fast-forward to ${tip}`]);
    }),
  );

  it.effect("makes a worktree for a local branch no worktree has, and fast-forwards it", () =>
    Effect.gen(function* () {
      const repo = makeRepository();
      trackingBranch(repo, null);
      repo.behindOnCreate = 3;
      const opened = yield* open(repo, { baseRef: "origin/main", expectCommit: tip });
      expect(opened).toMatchObject({ worktreePath: "/worktrees/app-1", created: true });
      expect(repo.log).toEqual([
        "fetch origin/feature",
        "worktree feature from feature",
        `fast-forward to ${tip}`,
      ]);
    }),
  );

  it.effect.each([
    {
      name: "has changes",
      change: (checkout: Checkout) => void (checkout.dirty = true),
      expected: "uncommitted changes",
    },
    {
      name: "has commits the remote lacks",
      change: (checkout: Checkout) => void ((checkout.ahead = 1), (checkout.behind = 1)),
      expected: "has commits that origin/feature does not",
    },
    {
      name: "compares against another base",
      change: (checkout: Checkout) => void (checkout.base = "origin/release"),
      expected: "compares against origin/release, not origin/main",
    },
  ])("leaves a worktree alone that $name", ({ change, expected }) =>
    Effect.gen(function* () {
      const repo = makeRepository();
      trackingBranch(repo, "/worktrees/earlier");
      change(repo.checkouts.get("/worktrees/earlier")!);
      const message = yield* failureOf(open(repo, { baseRef: "origin/main" }));
      expect(message).toContain(expected);
      expect(repo.log).toEqual(["fetch origin/feature"]);
    }),
  );

  it.effect("removes the worktree it made for a local branch that has commits of its own", () =>
    Effect.gen(function* () {
      const repo = makeRepository();
      trackingBranch(repo, null);
      repo.aheadOnCreate = 1;
      const message = yield* failureOf(open(repo));
      expect(message).toContain("has commits that origin/feature does not");
      // The branch was there before, so only the worktree goes.
      expect(repo.log).toEqual([
        "fetch origin/feature",
        "worktree feature from feature",
        "remove /worktrees/app-1",
      ]);
      expect(repo.branches.has("feature")).toBe(true);
    }),
  );

  it.effect("leaves a branch alone that tracks another branch", () =>
    Effect.gen(function* () {
      const repo = makeRepository();
      repo.branches.set("feature", { worktreePath: null, upstream: "refs/remotes/origin/other" });
      const message = yield* failureOf(open(repo));
      expect(message).toContain("tracks origin/other, not origin/feature");
      expect(repo.log).toEqual(["fetch origin/feature"]);
    }),
  );

  it.effect(
    "removes the worktree and the branch it made when the commit is not on the branch",
    () =>
      Effect.gen(function* () {
        const repo = makeRepository({ holds: [older] });
        const message = yield* failureOf(open(repo, { expectCommit: newer }));
        expect(message).toContain(`does not hold commit ${newer.slice(0, 7)}`);
        expect(repo.log).toEqual([
          "fetch origin/feature",
          "worktree feature from origin/feature",
          "remove /worktrees/app-1",
          "delete feature",
        ]);
        expect(repo.branches.size).toBe(0);
      }),
  );

  it.effect("keeps a worktree it reused when the commit is not on the branch", () =>
    Effect.gen(function* () {
      const repo = makeRepository({ holds: [older] });
      trackingBranch(repo, "/worktrees/earlier");
      yield* failureOf(open(repo, { expectCommit: newer }));
      expect(repo.log).not.toContain("remove /worktrees/earlier");
      expect(repo.checkouts.has("/worktrees/earlier")).toBe(true);
    }),
  );

  it.effect("needs the worktree capability", () =>
    Effect.gen(function* () {
      const repo = makeRepository();
      const message = yield* failureOf(open(repo, {}, ["orchestration"]));
      expect(message).toContain("does not grant worktree capabilities");
      expect(repo.log).toEqual([]);
    }),
  );
});
