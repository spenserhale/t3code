import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorktreeOpenBranch from "./WorktreeOpenBranch.ts";

// The same cases against real repositories: a remote, the checkout the project is, and a clone
// that pushes. Only the layer above git is faked, so the refs, tracking, worktrees and
// fast-forwards are git's own.

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-open-branch-git-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project:app");

/** A remote with `main` and `feature`, a clone to push from, and the project's own clone. */
const makeRepositories = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-open-branch-" });
  const run = (cwd: string, ...args: ReadonlyArray<string>) =>
    git
      .execute({ operation: "WorktreeOpenBranch.git.test", cwd, args, timeoutMs: 30_000 })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const origin = path.join(base, "origin.git");
  const pusher = path.join(base, "pusher");
  const box = path.join(base, "box");
  const identify = (cwd: string) =>
    run(cwd, "config", "user.email", "test@test.com").pipe(
      Effect.andThen(run(cwd, "config", "user.name", "Test")),
    );
  const commit = (cwd: string, file: string) =>
    fileSystem
      .writeFileString(path.join(cwd, file), `${file}\n`)
      .pipe(
        Effect.andThen(run(cwd, "add", file)),
        Effect.andThen(run(cwd, "commit", "-m", file)),
        Effect.andThen(run(cwd, "rev-parse", "HEAD")),
      );
  yield* run(base, "init", "--bare", "--initial-branch=main", origin);
  yield* run(base, "clone", origin, pusher);
  yield* identify(pusher);
  yield* commit(pusher, "main.txt");
  yield* run(pusher, "push", "origin", "HEAD:refs/heads/main");
  yield* run(pusher, "checkout", "-b", "feature");
  const first = yield* commit(pusher, "feature-1.txt");
  yield* run(pusher, "push", "origin", "feature");
  yield* run(base, "clone", origin, box);
  yield* identify(box);
  return { run, commit, fileSystem, path, origin, pusher, box, first };
});

/** A post-checkout hook that fails, as a project's own can once git has made the worktree. */
const failOnCheckout = (box: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hook = path.join(box, ".git", "hooks", "post-checkout");
    yield* fileSystem.writeFileString(hook, "#!/bin/sh\nexit 1\n");
    yield* fileSystem.chmod(hook, 0o755);
  });

/** `between` runs once the opener has looked at the branches, and before it asks git for a worktree. */
const open = (
  box: string,
  input: { readonly branch?: string } & Record<string, unknown> = {},
  between: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const project = {
      id: projectId,
      title: "app",
      workspaceRoot: box,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    } as Project;
    const services = Layer.mergeAll(
      Layer.succeed(GitVcsDriver.GitVcsDriver, git),
      // The driver is what GitWorkflowService hands these calls to.
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        isRepository: () => Effect.succeed(true),
        remoteExists: (request) => git.remoteExists(request),
        fetchWorktreeBaseCommit: (request) => git.fetchWorktreeBaseCommit(request),
        listRefs: (request) => git.listRefs(request),
        createWorktree: (request, options) =>
          between.pipe(Effect.andThen(git.createWorktree(request, options))),
        removeWorktree: (request) => git.removeWorktree(request),
        deleteLocalBranch: (request) => git.deleteLocalBranch(request),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedSome(project),
      }),
    );
    const service = yield* WorktreeOpenBranch.WorktreeOpenBranch.pipe(
      Effect.provide(WorktreeOpenBranch.layer.pipe(Layer.provide(services))),
    );
    return yield* service.open(
      {
        environmentId: EnvironmentId.make("environment-box"),
        requestNamespace: "provider-session-box",
        thread: undefined,
        client: undefined,
        capabilities: new Set(["orchestration", "worktree"]),
        issuedAt: 1,
      },
      { projectId, branch: "feature", ...input },
    );
  });

it.effect("opens a pushed branch on a real worktree, then moves it forward and only forward", () =>
  Effect.gen(function* () {
    const { run, commit, fileSystem, path, pusher, box, first } = yield* makeRepositories;

    // A branch the project has never heard of: fetched, tracked, and compared with main.
    const opened = yield* open(box, { baseBranch: "main", expectCommit: first });
    expect(opened).toMatchObject({
      branch: "feature",
      remote: "origin",
      head: first,
      created: true,
    });
    expect(yield* run(opened.worktreePath, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      "origin/feature",
    );
    expect(yield* run(box, "config", "branch.feature.t3-merge-base")).toBe("main");

    // Asked again, it is the same worktree, with nothing to move.
    const again = yield* open(box, { baseBranch: "main", expectCommit: first });
    expect(again).toMatchObject({ worktreePath: opened.worktreePath, head: first, created: false });

    // The remote moves on: the clean worktree follows it.
    const second = yield* commit(pusher, "feature-2.txt");
    yield* run(pusher, "push", "origin", "feature");
    const followed = yield* open(box, { expectCommit: second });
    expect(followed).toMatchObject({ worktreePath: opened.worktreePath, head: second });
    expect(yield* run(opened.worktreePath, "rev-parse", "HEAD")).toBe(second);

    // Changes in it, and the remote moves again: it is left as it is.
    yield* fileSystem.writeFileString(path.join(opened.worktreePath, "notes.txt"), "mine\n");
    const third = yield* commit(pusher, "feature-3.txt");
    yield* run(pusher, "push", "origin", "feature");
    const refused = yield* open(box, { expectCommit: third }).pipe(Effect.flip);
    expect(refused.message).toContain("uncommitted changes");
    expect(yield* run(opened.worktreePath, "rev-parse", "HEAD")).toBe(second);

    // Commits of its own, with the changes gone: left as it is too.
    yield* fileSystem.remove(path.join(opened.worktreePath, "notes.txt"));
    yield* commit(opened.worktreePath, "mine.txt");
    const diverged = yield* open(box, { expectCommit: third }).pipe(Effect.flip);
    expect(diverged.message).toContain("has commits that origin/feature does not");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("removes the worktree and branch it made when the branch lacks the commit", () =>
  Effect.gen(function* () {
    const { run, box, pusher } = yield* makeRepositories;
    // A commit that only the pusher has.
    const unpushed = yield* run(pusher, "commit", "--allow-empty", "-m", "unpushed").pipe(
      Effect.andThen(run(pusher, "rev-parse", "HEAD")),
    );
    const failed = yield* open(box, { expectCommit: unpushed }).pipe(Effect.flip);
    expect(failed.message).toContain("does not hold commit");
    expect(yield* run(box, "worktree", "list", "--porcelain")).not.toContain("refs/heads/feature");
    expect(yield* run(box, "branch", "--list", "feature")).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("does not fetch a branch the remote lacks, nor leave a stale one to be used", () =>
  Effect.gen(function* () {
    const { run, box, pusher } = yield* makeRepositories;
    // The project knows `feature` from a fetch; then it is deleted on the remote.
    yield* run(box, "fetch", "origin");
    yield* run(pusher, "push", "origin", "--delete", "feature");
    const failed = yield* open(box).pipe(Effect.flip);
    expect(failed.message).toContain("origin has no branch feature");
    expect(yield* run(box, "worktree", "list", "--porcelain")).not.toContain("feature");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("takes back what a failed checkout made, and leaves what was there before", () =>
  Effect.gen(function* () {
    const { run, fileSystem, path, box } = yield* makeRepositories;
    const { worktreesDir } = yield* ServerConfig.ServerConfig;

    // Someone's folder is where the worktree would go: git refuses, and the branch made for it goes.
    const occupied = path.join(worktreesDir, "box", "feature");
    yield* fileSystem.makeDirectory(occupied, { recursive: true });
    yield* fileSystem.writeFileString(path.join(occupied, "keep.txt"), "mine\n");
    const blocked = yield* open(box).pipe(Effect.flip);
    expect(blocked.message).toContain("Could not make a worktree on origin/feature");
    expect(yield* fileSystem.readFileString(path.join(occupied, "keep.txt"))).toBe("mine\n");
    expect(yield* run(box, "branch", "--list", "feature")).toBe("");

    // Git makes the worktree, then a hook fails: the worktree and the branch go.
    yield* fileSystem.remove(occupied, { recursive: true });
    yield* failOnCheckout(box);
    const hooked = yield* open(box).pipe(Effect.flip);
    expect(hooked.message).toContain("Could not make a worktree on origin/feature");
    expect(yield* run(box, "worktree", "list", "--porcelain")).not.toContain("feature");
    expect(yield* fileSystem.exists(occupied)).toBe(false);
    expect(yield* run(box, "branch", "--list", "feature")).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("keeps a branch that was already there when its worktree fails", () =>
  Effect.gen(function* () {
    const { run, box } = yield* makeRepositories;
    yield* run(box, "fetch", "origin");
    yield* run(box, "branch", "--track", "feature", "origin/feature");
    yield* failOnCheckout(box);
    const hooked = yield* open(box).pipe(Effect.flip);
    expect(hooked.message).toContain("Could not make a worktree for feature");
    expect(yield* run(box, "worktree", "list", "--porcelain")).not.toContain("feature");
    expect(yield* run(box, "branch", "--list", "feature")).toContain("feature");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect(
  "compares with the base on the remote that is its repository, whatever it is called",
  () =>
    Effect.gen(function* () {
      const { run, origin, pusher, box, first } = yield* makeRepositories;
      // Here the repository is `team`, and `origin` is another one, which also has a main.
      yield* run(box, "remote", "rename", "origin", "team");
      yield* run(box, "remote", "add", "origin", pusher);
      yield* run(box, "fetch", "origin");
      const opened = yield* open(box, {
        repositoryKey: sourceControlDefinitions.repositoryKeyFromRemote(origin)!,
        baseBranch: "main",
        expectCommit: first,
      });
      expect(opened.remote).toBe("team");
      expect(yield* run(box, "config", "branch.feature.t3-merge-base-ref")).toBe(
        "refs/remotes/team/main",
      );
    }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("leaves the worktree another operation made for the branch in the meantime", () =>
  Effect.gen(function* () {
    const { run, fileSystem, path, box } = yield* makeRepositories;
    const { worktreesDir } = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    yield* run(box, "fetch", "origin");
    yield* run(box, "branch", "--track", "feature", "origin/feature");

    // The opener found `feature` without a worktree; then another checkout takes it, at the very
    // path the opener would use, and has work in it that is not committed.
    const theirs = path.join(worktreesDir, "box", "feature");
    const takeBranch = git
      .createWorktree({ cwd: box, refName: "feature", path: null })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(path.join(theirs, "notes.txt"), "uncommitted\n")),
        Effect.orDie,
      );
    const failed = yield* open(box, {}, takeBranch).pipe(Effect.flip);
    expect(failed.message).toContain("Could not make a worktree for feature");
    expect(failed.message).toContain("left as it was");
    expect(yield* fileSystem.readFileString(path.join(theirs, "notes.txt"))).toBe("uncommitted\n");
    expect(yield* run(box, "worktree", "list", "--porcelain")).toContain(theirs);
    expect(yield* run(box, "branch", "--list", "feature")).toContain("feature");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("leaves the branch and worktree another operation made first", () =>
  Effect.gen(function* () {
    const { run, fileSystem, path, box } = yield* makeRepositories;
    const { worktreesDir } = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;

    // The project had no `feature`; another operation makes it, with its worktree, before the opener.
    const theirs = path.join(worktreesDir, "box", "feature");
    const takeBranch = git
      .createWorktree({ cwd: box, refName: "origin/feature", newRefName: "feature", path: null })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(path.join(theirs, "notes.txt"), "uncommitted\n")),
        Effect.orDie,
      );
    const failed = yield* open(box, {}, takeBranch).pipe(Effect.flip);
    expect(failed.message).toContain("Could not make a worktree on origin/feature");
    expect(failed.message).toContain("left as it was");
    expect(yield* fileSystem.readFileString(path.join(theirs, "notes.txt"))).toBe("uncommitted\n");
    expect(yield* run(box, "worktree", "list", "--porcelain")).toContain(theirs);
    expect(yield* run(box, "branch", "--list", "feature")).toContain("feature");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);
