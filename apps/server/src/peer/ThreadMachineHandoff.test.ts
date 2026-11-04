import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GitCommandError,
  GitManagerError,
  type GitRunStackedActionResult,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpFailure,
  PeerLinkError,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type RepositoryIdentity,
  type ThreadContinueOnMachineInput,
  type ThreadContinueOnMachineResult,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Tool } from "effect/ai";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as ThreadMachineHandoff from "./ThreadMachineHandoff.ts";

const laptop = EnvironmentId.make("environment-laptop");
const linkMini = EnvironmentId.make("environment-linkmini");
const sourceThread = ThreadId.make("thread:laptop-1");
const otherThread = ThreadId.make("thread:laptop-2");
const codex = ProviderInstanceId.make("codex");
const tip = "d".repeat(40);
const wipCommit = "e".repeat(40);

const identity = {
  canonicalKey: "github.com/acme/app",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/app.git",
  },
  rootPath: "/work/app",
} as RepositoryIdentity;

const projectOn = (id: string, root: string, key = "github.com/acme/app") =>
  ({
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: root,
    repositoryIdentity: { ...identity, canonicalKey: key, rootPath: root },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  }) as Project;

const sourceProject = projectOn("project:laptop", "/work/app");

const statusOf = (overrides: Partial<VcsStatusResult> = {}) =>
  ({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/login",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/login.ts", insertions: 3, deletions: 1 }],
      insertions: 3,
      deletions: 1,
    },
    branchChanges: { baseRef: "origin/main", insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  }) as VcsStatusResult;

const encodeWith = (schema: Schema.Encoder<unknown>, value: unknown) =>
  Schema.encodeUnknownSync(schema)(value);
const encodeResultWith = (schema: Schema.Encoder<unknown>, value: unknown) =>
  Schema.encodeUnknownEffect(schema)(value);

/** What the other machine's refusal looks like once the link has decoded it. */
interface FakeFailure {
  readonly _tag: "OrchestratorMcpFailure";
  readonly code: string;
  readonly message: string;
}

interface Options {
  readonly linksEnabled?: boolean;
  readonly linked?: boolean;
  /** The thread being handed off is not the one calling. */
  readonly other?: boolean;
  readonly shell?: Partial<OrchestrationV2ThreadShell>;
  readonly status?: Partial<VcsStatusResult>;
  /** Whether the repository names its default branch. */
  readonly defaultKnown?: boolean;
  readonly takenBranches?: ReadonlyArray<string>;
  readonly scratch?: boolean;
  readonly noRemote?: boolean;
  readonly targetProjects?: ReadonlyArray<Project>;
  readonly targetModels?: ReadonlyArray<string>;
  readonly pushedTo?: string;
  readonly pushFails?: "after-commit" | "before-commit";
  readonly openBranch?: "missing" | "fails" | "dirty" | "elsewhere";
  /** Asking the other machine whether it accepted a launch fails: it lacks the tool, or is silent. */
  readonly lookup?: "missing" | "fails";
  readonly launchFails?: boolean;
  /** The other machine starts the thread, but the reply never reaches this one. */
  readonly launchLosesReply?: boolean;
  readonly settleFails?: boolean;
  /** The changes the checkout showed were gone by the time the commit step looked. */
  readonly nothingToCommit?: boolean;
  /** The other machine answers the upload with this instead of accepting it. */
  readonly uploadRefused?: { readonly status: number; readonly text: string };
  /** The call comes through a link, as an outside agent of a machine that linked to this one. */
  readonly linkedCaller?: boolean;
  /** Something else moves the checkout to this branch before the commit step holds it. */
  readonly switchedBeforeLease?: string;
  /** The checkout's remotes, by name. */
  readonly remotes?: Record<string, string>;
  /** The first upload says it has begun, then waits to be let go: a call held mid-preparation. */
  readonly firstUploadHeld?: {
    readonly begun: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const makeHarness = (initial: Options = {}) => {
  // A test changes what happens between its calls: the other machine recovers, the worktree there changes.
  const options: Mutable<Options> = { ...initial };
  const log: string[] = [];
  const forwarded: Array<{
    readonly tool: string;
    readonly environmentId: string;
    readonly params: Record<string, any>;
    readonly options: { readonly attachmentsOnPeer?: boolean } | undefined;
  }> = [];
  const uploads: Array<{ readonly url: string; readonly text: string }> = [];
  const settled: Array<{ readonly threadId: string; readonly byOwnAgent: boolean }> = [];
  const dispatched: unknown[] = [];
  const pushes: Array<{ readonly cwd: string; readonly branch: string | null }> = [];
  // Once the work is committed and pushed, the checkout shows nothing left to carry.
  let carried = false;
  let firstUploadSeen = false;
  // The project of the launch the other machine accepted, if it has.
  let accepted: ProjectId | undefined;
  let currentBranch: string | null =
    options.status !== undefined && "refName" in options.status
      ? (options.status.refName ?? null)
      : "feature/login";

  const targetModels = options.targetModels ?? ["gpt-5"];
  const callingId = options.other === true ? otherThread : sourceThread;
  const shell = (id: ThreadId): OrchestrationV2ThreadShell => ({
    ...liveThreadShell(id, { activeRunId: null }),
    projectId: sourceProject.id,
    title: "Fix the flaky login",
    status: "idle",
    ...options.shell,
  });
  const scope: McpInvocationScope = {
    environmentId: laptop,
    requestNamespace: "provider-session-1",
    thread:
      options.linkedCaller === true
        ? undefined
        : {
            threadId: callingId,
            providerSessionId: "provider-session-1",
            providerInstanceId: codex,
          },
    client:
      options.linkedCaller === true
        ? { sessionId: "session:link", label: "T3 Code · Server", access: "auto", linked: true }
        : undefined,
    capabilities: new Set(["orchestration", "worktree"]),
    issuedAt: 1,
  };

  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed(id === sourceThread || id === otherThread ? shell(id) : null),
    getThreadTranscript: (id) =>
      Effect.succeed({
        threadId: id,
        title: "Fix the flaky login",
        updatedAt: DateTime.makeUnsafe("2026-11-02T10:00:00.000Z"),
        items: [
          { id: "item-1", type: "message" },
          { id: "item-2", type: "message" },
        ] as never,
      }),
    dispatch: (command) => {
      log.push(`dispatch ${command.type}`);
      dispatched.push(command);
      return Effect.succeed({ sequence: 1, storedEvents: [] } as never);
    },
    settleThread: (input) => {
      log.push("settle");
      settled.push({ threadId: input.threadId, byOwnAgent: input.byOwnAgent });
      return options.settleFails === true
        ? Effect.fail({ _tag: "OrchestratorDispatchError" } as never)
        : Effect.succeed(
            input.byOwnAgent ? { settlesWhenTurnEnds: true as const } : { sequence: 5 },
          );
    },
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: (id) =>
      Effect.succeed(id === sourceProject.id ? Option.some(sourceProject) : Option.none()),
  });
  const folders = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "",
    isScratchProject: () => Effect.succeed(options.scratch === true),
  });
  const identities = Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
    resolve: () => Effect.succeed(options.noRemote === true ? null : identity),
  });
  const gitWorkflow = Layer.mock(GitWorkflowService.GitWorkflowService)({
    listRefs: (input) => {
      log.push(input.query === undefined ? "git listRefs" : `git listRefs ${input.query}`);
      return Effect.succeed({
        refs:
          input.query === undefined
            ? options.defaultKnown === false
              ? []
              : [
                  {
                    name: "main",
                    isDefault: true,
                    current: false,
                    worktreePath: null,
                  },
                ]
            : (options.takenBranches ?? []).map((name) => ({
                name,
                isDefault: false,
                current: false,
                worktreePath: null,
                ...(name.startsWith("origin/") ? { isRemote: true, remoteName: "origin" } : {}),
              })),
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 1,
      });
    },
    createRef: (input) => {
      log.push(`git createRef ${input.refName}`);
      currentBranch = input.refName;
      return Effect.succeed({ refName: input.refName });
    },
    runStackedAction: (input, runOptions) =>
      Effect.gen(function* () {
        log.push(`git ${input.action}`);
        // The checkout is anyone's until this action holds its lease, and it checks then.
        if (options.switchedBeforeLease !== undefined) currentBranch = options.switchedBeforeLease;
        const expected = runOptions?.expectedBranch;
        if (expected !== undefined && expected !== currentBranch) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: `The checkout is on ${currentBranch ?? "no branch"}, not ${expected}, so nothing was committed or pushed.`,
          });
        }
        pushes.push({ cwd: input.cwd, branch: currentBranch });
        const publish = runOptions?.progressReporter?.publish;
        const phase = (name: "commit" | "push") =>
          publish === undefined
            ? Effect.void
            : publish({
                kind: "phase_started",
                phase: name,
                label: name,
                actionId: input.actionId,
                cwd: input.cwd,
                action: input.action,
              });
        if (options.pushFails === "before-commit") {
          return yield* new GitCommandError({
            operation: "commit",
            command: "git commit",
            cwd: input.cwd,
            detail: "pre-commit hook failed",
          });
        }
        if (options.nothingToCommit !== true) yield* phase("commit");
        yield* phase("push");
        if (options.pushFails === "after-commit") {
          return yield* new GitCommandError({
            operation: "push",
            command: "git push",
            cwd: input.cwd,
            detail: "rejected",
            reason: "push_rejected_non_fast_forward",
          });
        }
        carried = true;
        return {
          action: "commit_push",
          branch: { status: "skipped_not_requested" },
          commit:
            options.nothingToCommit === true
              ? { status: "skipped_no_changes" }
              : { status: "created", commitSha: wipCommit },
          push: {
            status: "pushed",
            branch: currentBranch ?? "",
            upstreamBranch: options.pushedTo ?? `origin/${currentBranch}`,
          },
          pr: { status: "skipped_not_requested" },
          toast: { title: "Pushed", cta: { kind: "none" } },
        } satisfies GitRunStackedActionResult;
      }),
  });
  const git = Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: () =>
      Effect.succeed({
        exitCode: 0,
        stdout: Object.entries(options.remotes ?? { origin: "git@github.com:acme/app.git" })
          .map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)`)
          .join("\n"),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      } as GitVcsDriver.ExecuteGitResult),
    resolveCommit: () => Effect.succeed({ commitSha: tip }),
  });
  const status = Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
    refreshStatus: () => {
      log.push("git status");
      return Effect.succeed(
        statusOf({
          ...options.status,
          refName: currentBranch,
          isDefaultRef: currentBranch === "main",
          ...(carried
            ? {
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
              }
            : {}),
        }),
      );
    },
  });
  const respond = (
    name: string,
    params: Record<string, any>,
  ): Effect.Effect<unknown, FakeFailure> => {
    switch (name) {
      case "t3_project_list":
        return Effect.succeed({
          projects: options.targetProjects ?? [projectOn("project:linkmini", "/srv/app")],
          nextCursor: null,
        });
      case "t3_project_read":
        return Effect.succeed(projectOn(params.projectId, "/srv/app"));
      case "orchestrator_capabilities":
        return Effect.succeed({
          parentThreadId: null,
          inheritedProviderInstanceId: null,
          inheritedModel: null,
          runtimeMode: "auto",
          interactionMode: "default",
          providers: [
            {
              providerInstanceId: codex,
              driverKind: "codex",
              displayName: null,
              models: targetModels.map((id) => ({ id })),
              canRunChildTask: true,
              canRunCrossProviderChildTask: true,
              constraints: [],
            },
          ],
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            batchThreadCreation: true,
            threadManagement: true,
            incrementalThreadRead: true,
            scheduledTasks: true,
            maxBatchThreads: 20,
          },
        });
      case "t3_attachment_prepare_upload":
        return Effect.succeed({
          attachmentId: "pending-1",
          relativeUrl: "/api/attachments/upload/signed",
          expiresAt: 1,
        });
      case "t3_worktree_open_branch":
        if (options.openBranch === "missing") {
          return Effect.fail({
            _tag: "OrchestratorMcpFailure",
            code: "invalid_request",
            message: "Tool 't3_worktree_open_branch' not found",
          });
        }
        if (options.openBranch === "dirty") {
          return Effect.fail({
            _tag: "OrchestratorMcpFailure",
            code: "invalid_request",
            message:
              "feature/login is checked out in /worktrees/app-1, which has uncommitted changes, so it was left alone.",
          });
        }
        if (options.openBranch === "fails") {
          return Effect.fail({
            _tag: "OrchestratorMcpFailure",
            code: "invalid_request",
            message: "origin has no branch feature/login.",
          });
        }
        return Effect.succeed({
          // "elsewhere": the checkout that held the branch is on another one now.
          worktreePath:
            options.openBranch === "elsewhere" ? "/worktrees/app-2" : "/worktrees/app-1",
          branch: params.branch,
          remote: "origin",
          head: params.expectCommit,
          created: true,
        });
      case "t3_thread_launch":
        // A launch for a model the machine lacks is refused there, after the work was pushed.
        if (
          params.modelSelection.instanceId !== codex ||
          !targetModels.includes(params.modelSelection.model)
        ) {
          return Effect.fail({
            _tag: "OrchestratorMcpFailure",
            code: "model_unavailable",
            message: `The model ${params.modelSelection.model} is not available.`,
          });
        }
        if (options.launchFails === true) {
          return Effect.fail({
            _tag: "OrchestratorMcpFailure",
            code: "orchestration_error",
            message: "The linked environment stopped answering.",
          });
        }
        // The other machine accepts the launch, and its reply may still not get back.
        accepted = params.projectId ?? ProjectId.make("project:linkmini-scratch");
        if (options.launchLosesReply === true) {
          return Effect.fail({
            _tag: "OrchestratorMcpFailure",
            code: "orchestration_error",
            message: "The reply never arrived.",
          });
        }
        return Effect.succeed({
          threadId: ThreadId.make("thread:linkmini-1"),
          link: "<t3-thread://v2/environment-linkmini/thread:linkmini-1>",
          projectId: accepted,
          modelSelection: params.modelSelection,
          runId: null,
          status: null,
        });
      case "t3_thread_launch_lookup":
        if (options.lookup !== undefined) {
          return Effect.fail({
            _tag: "OrchestratorMcpFailure",
            code: options.lookup === "missing" ? "invalid_request" : "orchestration_error",
            message:
              options.lookup === "missing"
                ? "Tool 't3_thread_launch_lookup' not found"
                : "The linked environment stopped answering.",
          });
        }
        return Effect.succeed({
          launched:
            accepted === undefined
              ? null
              : {
                  threadId: ThreadId.make("thread:linkmini-1"),
                  link: "<t3-thread://v2/environment-linkmini/thread:linkmini-1>",
                  projectId: accepted,
                },
        });
    }
    return Effect.die(`unexpected ${name}`);
  };
  const forwarding = Layer.mock(PeerForwarding.PeerForwarding)({
    call: ((
      _scope: unknown,
      tool: Tool.Any,
      environmentId: string,
      params: Record<string, any>,
      callOptions?: { attachmentsOnPeer?: boolean },
    ) => {
      log.push(`forward ${tool.name}`);
      forwarded.push({ tool: tool.name, environmentId, params, options: callOptions });
      // What goes out must encode with the tool's own schema, and what comes back must be a
      // result that schema describes: the other machine decodes both.
      encodeWith(tool.parametersSchema as Schema.Encoder<unknown>, params);
      return respond(tool.name, params).pipe(
        Effect.tap((result) =>
          encodeResultWith(tool.successSchema as Schema.Encoder<unknown>, result).pipe(
            Effect.orDie,
          ),
        ),
      );
    }) as never,
  });
  const links = Layer.mock(PeerLinks.PeerLinks)({
    enabled: Effect.succeed(options.linksEnabled !== false),
    resolve: (id) => {
      log.push("link resolve");
      return options.linked === false
        ? Effect.fail(new PeerLinkError({ reason: "unknown_link", message: `not linked to ${id}` }))
        : Effect.succeed({
            link: {
              environmentId: id,
              label: "LinkMini",
              urls: ["http://linkmini.test"],
              access: "auto" as const,
              linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
              expiresAt: DateTime.makeUnsafe("2027-11-01T00:00:00.000Z"),
              lastReachedAt: null,
              lastError: null,
            },
            url: "http://linkmini.test",
            token: "secret",
          });
    },
  });
  const environment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(laptop),
    getDescriptor: Effect.succeed({ environmentId: laptop, label: "Laptop" } as never),
  });
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const held = options.firstUploadHeld;
        if (held !== undefined && !firstUploadSeen) {
          firstUploadSeen = true;
          yield* Deferred.succeed(held.begun, undefined);
          yield* Deferred.await(held.release);
        }
        log.push("upload");
        uploads.push({
          url: request.url,
          text:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return options.uploadRefused === undefined
          ? HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
          : HttpClientResponse.fromWeb(
              request,
              new Response(options.uploadRefused.text, { status: options.uploadRefused.status }),
            );
      }),
    ),
  );

  const layer = ThreadMachineHandoff.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threads,
        projects,
        folders,
        identities,
        gitWorkflow,
        git,
        status,
        forwarding,
        links,
        environment,
        http,
        NodeCrypto.layer,
      ),
    ),
  );
  /** Calls that share one service, as a retry does: what an earlier call recorded is there for it. */
  const session = <A, E>(
    body: (
      handOff: (
        input?: Partial<ThreadContinueOnMachineInput>,
      ) => Effect.Effect<ThreadContinueOnMachineResult, OrchestratorMcpFailure>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const service = yield* ThreadMachineHandoff.ThreadMachineHandoff;
      return yield* body((input = {}) =>
        service.continueOnMachine(scope, {
          environmentId: linkMini,
          threadId: options.other === true ? sourceThread : undefined,
          ...input,
        }),
      );
    }).pipe(Effect.provide(layer));
  const run = (input: Partial<ThreadContinueOnMachineInput> = {}) =>
    session((handOff) => handOff(input));
  const failed = (input: Partial<ThreadContinueOnMachineInput> = {}) =>
    run(input).pipe(
      Effect.flip,
      Effect.map((error: OrchestratorMcpFailure) => error),
    );
  return { run, failed, session, options, log, forwarded, uploads, settled, dispatched, pushes };
};

const gitWrites = (log: ReadonlyArray<string>) =>
  log.filter((entry) => /^git (createRef|commit_push)/.test(entry) || entry === "upload");

describe("t3_thread_continue_on_machine", () => {
  describe("before it touches anything", () => {
    it.effect("is refused while Linked environments is off", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ linksEnabled: false });
        const error = yield* harness.failed();
        expect(error.message).toContain("Linked environments is off");
        expect(harness.log).toEqual([]);
      }),
    );

    it.effect("is refused for a machine that is not linked, saying how to link it", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ linked: false });
        const error = yield* harness.failed();
        expect(error.message).toContain("is not a linked environment");
        expect(error.message).toContain("t3_environment_link");
        expect(harness.log).toEqual(["link resolve"]);
      }),
    );

    it.effect("is refused for work a link started, which never uses this machine's links", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ linkedCaller: true });
        const error = yield* harness.failed({ threadId: sourceThread });
        expect(error.code).toBe("capability_denied");
        expect(error.message).toContain(
          "started from T3 Code · Server through a linked environment",
        );
        expect(harness.log).toEqual([]);
      }),
    );

    it.effect("is refused for the machine the thread is on", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const error = yield* harness.failed({ environmentId: laptop });
        expect(error.message).toContain("machine this thread is on");
        expect(harness.log).toEqual([]);
      }),
    );

    it.effect("is refused for a thread that is working or waiting on an approval", () =>
      Effect.gen(function* () {
        const working = makeHarness({ other: true, shell: { status: "running" } });
        expect((yield* working.failed()).message).toContain("still working");
        const waiting = makeHarness({
          other: true,
          shell: {
            pendingRuntimeRequest: {
              id: "request-1",
              kind: "command_approval",
              createdAt: DateTime.makeUnsafe("2026-11-02T10:00:00.000Z"),
            } as never,
          },
        });
        expect((yield* waiting.failed()).message).toContain("waiting on an approval");
        expect(gitWrites(working.log)).toEqual([]);
        expect(gitWrites(waiting.log)).toEqual([]);
      }),
    );

    it.effect("is refused for an archived thread", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          shell: { archivedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z") },
        });
        expect((yield* harness.failed()).message).toContain("archived");
      }),
    );

    it.effect("is refused from a detached head, before the conversation is uploaded", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ status: { refName: null } });
        const error = yield* harness.failed();
        expect(error.message).toContain("not on a branch");
        expect(gitWrites(harness.log)).toEqual([]);
        expect(harness.forwarded).toEqual([]);
      }),
    );

    it.effect(
      "is refused when the target lacks the model, the thread's or one the agent names",
      () =>
        Effect.gen(function* () {
          const inherited = makeHarness({ targetModels: ["something-else"] });
          const error = yield* inherited.failed();
          expect(error.code).toBe("model_unavailable");
          expect(error.message).toContain("orchestrator_capabilities with environmentId");
          expect(gitWrites(inherited.log)).toEqual([]);
          const named = makeHarness();
          const refused = yield* named.failed({
            modelSelection: { instanceId: codex, model: "gpt-6" },
          });
          expect(refused.code).toBe("model_unavailable");
          expect(refused.message).toContain("but not the model gpt-6");
          expect(gitWrites(named.log)).toEqual([]);
        }),
    );

    it.effect("launches with a model the agent names once the target has it", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ targetModels: ["gpt-5", "gpt-6"] });
        yield* harness.run({ modelSelection: { instanceId: codex, model: "gpt-6" } });
        expect(harness.forwarded.at(-1)?.params.modelSelection).toEqual({
          instanceId: codex,
          model: "gpt-6",
        });
      }),
    );
  });

  describe("carrying the code", () => {
    it.effect("commits and pushes the branch it is on, then opens it there", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const result = yield* harness.run();
        expect(harness.pushes).toEqual([{ cwd: "/work/app", branch: "feature/login" }]);
        expect(gitWrites(harness.log)).toEqual(["upload", "git commit_push"]);
        expect(result).toEqual({
          environmentId: linkMini,
          threadId: "thread:linkmini-1",
          link: "<t3-thread://v2/environment-linkmini/thread:linkmini-1>",
          projectId: "project:linkmini",
          branch: "feature/login",
          pushedCommit: tip,
          worktreePath: "/worktrees/app-1",
          sourceSettles: "at_turn_end",
        });
      }),
    );

    it.effect(
      "moves default-branch work to a new handoff branch and never pushes the default",
      () =>
        Effect.gen(function* () {
          const harness = makeHarness({
            status: { refName: "main", isDefaultRef: true, aheadCount: 1 },
            takenBranches: ["origin/handoff/fix-the-flaky-login"],
          });
          yield* harness.run();
          expect(gitWrites(harness.log)).toEqual([
            "upload",
            "git createRef handoff/fix-the-flaky-login-2",
            "git commit_push",
          ]);
          expect(harness.pushes).toEqual([
            { cwd: "/work/app", branch: "handoff/fix-the-flaky-login-2" },
          ]);
          // The thread follows the checkout onto the new branch.
          expect(harness.dispatched).toMatchObject([
            {
              type: "thread.metadata.update",
              threadId: sourceThread,
              branch: "handoff/fix-the-flaky-login-2",
            },
          ]);
          const open = harness.forwarded.find((call) => call.tool === "t3_worktree_open_branch");
          expect(open?.params.branch).toBe("handoff/fix-the-flaky-login-2");
        }),
    );

    it.effect("never commits to a branch the checkout was moved to after it was read", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ switchedBeforeLease: "main" });
        const error = yield* harness.failed();
        expect(error.message).toContain("not feature/login, so nothing was committed or pushed");
        expect(harness.pushes).toEqual([]);
        expect(harness.forwarded.map((call) => call.tool)).not.toContain("t3_worktree_open_branch");
        expect(harness.settled).toEqual([]);
      }),
    );

    it.effect("treats a branch of a repository that names no default as the default", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ defaultKnown: false });
        yield* harness.run();
        expect(harness.log).toContain("git createRef handoff/fix-the-flaky-login");
        expect(harness.pushes[0]?.branch).toBe("handoff/fix-the-flaky-login");
      }),
    );

    it.effect("says what to do about a push the remote refused, and where the WIP commit is", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ pushFails: "after-commit" });
        const error = yield* harness.failed();
        expect(error.message).toContain("Pull them, then hand off again.");
        expect(error.message).toContain("Its WIP commit was not pushed.");
        expect(harness.forwarded.map((call) => call.tool)).not.toContain("t3_worktree_open_branch");
        expect(harness.settled).toEqual([]);
      }),
    );

    it.effect("names a WIP commit in the note only when one was made", () =>
      Effect.gen(function* () {
        const made = makeHarness();
        yield* made.run();
        const skipped = makeHarness({ nothingToCommit: true });
        yield* skipped.run();
        const messageOf = (harness: typeof made) =>
          harness.forwarded.find((call) => call.tool === "t3_thread_launch")?.params.message;
        expect(messageOf(made)).toContain("includes a WIP commit");
        expect(messageOf(skipped)).toContain("which tracks `origin/feature/login`.");
        expect(messageOf(skipped)).not.toContain("WIP commit");
      }),
    );

    it.effect("does not call a failed commit a WIP commit left behind", () =>
      Effect.gen(function* () {
        const error = yield* makeHarness({ pushFails: "before-commit" }).failed();
        expect(error.message).toContain("pre-commit hook failed");
        expect(error.message).not.toContain("WIP commit");
      }),
    );
  });

  describe("on the other machine", () => {
    it.effect("finds the project that has the repository, and asks for the branch there", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          targetProjects: [
            projectOn("project:other", "/srv/other", "github.com/acme/other"),
            projectOn("project:linkmini", "/srv/app"),
          ],
        });
        yield* harness.run();
        const open = harness.forwarded.find((call) => call.tool === "t3_worktree_open_branch");
        expect(open).toMatchObject({
          environmentId: linkMini,
          params: {
            projectId: "project:linkmini",
            branch: "feature/login",
            repositoryKey: "github.com/acme/app",
            baseBranch: "main",
            expectCommit: tip,
          },
        });
      }),
    );

    it.effect(
      "names the comparison base by its repository and branch, not by a remote's name",
      () =>
        Effect.gen(function* () {
          const remotes = {
            origin: "git@github.com:acme/app.git",
            upstream: "git@github.com:acme/upstream.git",
          };
          const cases = [
            { baseRef: "origin/main", expected: { baseBranch: "main" } },
            {
              baseRef: "upstream/release/2.0",
              expected: {
                baseBranch: "release/2.0",
                baseRepositoryKey: "github.com/acme/upstream",
              },
            },
            {
              baseRef: "refs/remotes/upstream/dev",
              expected: { baseRepositoryKey: "github.com/acme/upstream", baseBranch: "dev" },
            },
            { baseRef: "refs/heads/develop", expected: { baseBranch: "develop" } },
          ];
          for (const { baseRef, expected } of cases) {
            const harness = makeHarness({
              remotes,
              status: { branchChanges: { baseRef, insertions: 0, deletions: 0 } },
            });
            yield* harness.run();
            const open = harness.forwarded.find((call) => call.tool === "t3_worktree_open_branch");
            expect(open?.params, baseRef).toEqual({
              projectId: "project:linkmini",
              branch: "feature/login",
              repositoryKey: "github.com/acme/app",
              expectCommit: tip,
              ...expected,
            });
          }
          const bare = makeHarness({ status: { branchChanges: undefined } });
          yield* bare.run();
          const open = bare.forwarded.find((call) => call.tool === "t3_worktree_open_branch");
          expect(Object.keys(open?.params ?? {})).not.toContain("baseBranch");
        }),
    );

    it.effect("asks for a project when it has none with the repository, or several", () =>
      Effect.gen(function* () {
        const none = makeHarness({ targetProjects: [] });
        expect((yield* none.failed()).message).toContain(
          "No project on LinkMini has this repository",
        );
        const several = makeHarness({
          targetProjects: [projectOn("project:a", "/srv/a"), projectOn("project:b", "/srv/b")],
        });
        expect((yield* several.failed()).message).toContain("Several projects on LinkMini");
        expect(gitWrites(none.log)).toEqual([]);
        expect(gitWrites(several.log)).toEqual([]);
      }),
    );

    it.effect("tells a monorepo's projects apart by where they are in the repository", () =>
      Effect.gen(function* () {
        const inRepository = (id: string, root: string) => ({
          ...projectOn(id, root),
          repositoryIdentity: { ...identity, rootPath: "/srv/mono" },
        });
        const harness = makeHarness({
          targetProjects: [
            inRepository("project:mono-root", "/srv/mono"),
            inRepository("project:mono-app", "/srv/mono/app"),
          ],
        });
        // The source project is the repository's root.
        const result = yield* harness.run();
        expect(result.projectId).toBe("project:mono-root");
      }),
    );

    it.effect("uploads the conversation first, and attaches that upload to the launch", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* harness.run();
        expect(harness.log.indexOf("upload")).toBeLessThan(harness.log.indexOf("git commit_push"));
        const prepare = harness.forwarded.find(
          (call) => call.tool === "t3_attachment_prepare_upload",
        );
        expect(prepare?.params.upload).toMatchObject({
          type: "file",
          mimeType: "application/x-ndjson",
        });
        expect(harness.uploads).toHaveLength(1);
        expect(harness.uploads[0]?.url).toBe("http://linkmini.test/api/attachments/upload/signed");
        const [header, ...rows] = harness.uploads[0]!.text.trim().split("\n");
        expect(JSON.parse(header!)).toMatchObject({
          title: "Fix the flaky login",
          environmentId: laptop,
          threadId: sourceThread,
        });
        expect(rows.map((row) => JSON.parse(row).id)).toEqual(["item-1", "item-2"]);
        expect(prepare?.params.upload.sizeBytes).toBe(
          new TextEncoder().encode(harness.uploads[0]!.text).byteLength,
        );
        const launch = harness.forwarded.find((call) => call.tool === "t3_thread_launch");
        expect(launch?.params.attachments).toEqual([
          {
            type: "file",
            id: "pending-1",
            name: expect.stringMatching(/^Fix the flaky login-.*\.jsonl$/),
            mimeType: "application/x-ndjson",
            sizeBytes: prepare?.params.upload.sizeBytes,
          },
        ]);
        expect(launch?.options).toEqual({ attachmentsOnPeer: true });
      }),
    );

    it.effect("launches in the worktree on the same branch, with a note that links back", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* harness.run({ message: "Finish the retry test.", clientRequestId: "retry-1" });
        const launch = harness.forwarded.find((call) => call.tool === "t3_thread_launch");
        expect(launch?.params).toMatchObject({
          projectId: "project:linkmini",
          title: "Fix the flaky login",
          modelSelection: { instanceId: codex },
          workspaceStrategy: {
            type: "existing_worktree",
            worktreePath: "/worktrees/app-1",
            branch: "feature/login",
          },
          clientRequestId: "retry-1",
        });
        expect(launch?.params.message).toBe(
          [
            'Continuing "Fix the flaky login", handed off from Laptop.',
            "",
            "- The worktree continues `feature/login`, which tracks `origin/feature/login` and includes a WIP commit of the uncommitted changes.",
            "- Source thread: <t3-thread://v2/environment-laptop/thread:laptop-1>",
            "- The conversation so far is attached for reference.",
            "",
            "Finish the retry test.",
          ].join("\n"),
        );
      }),
    );

    it.effect("says the other machine needs a version with the tool, and where the work is", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ openBranch: "missing" });
        const error = yield* harness.failed();
        expect(error.message).toContain(
          "LinkMini runs a T3 Code version that does not have t3_worktree_open_branch",
        );
        expect(error.message).toContain(`pushed to origin/feature/login (${tip.slice(0, 7)})`);
        expect(harness.settled).toEqual([]);
      }),
    );

    it.effect("stops before pushing when the other machine refuses the conversation", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          uploadRefused: { status: 400, text: "Body was 3 bytes, expected 5." },
        });
        const error = yield* harness.failed();
        expect(error.message).toContain(
          "LinkMini refused the conversation upload (HTTP 400: Body was 3 bytes, expected 5.)",
        );
        expect(gitWrites(harness.log)).toEqual(["upload"]);
      }),
    );

    it.effect("keeps the worktree and says so when the launch fails after it was made", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ launchFails: true });
        const error = yield* harness.failed();
        expect(error.message).toContain("stopped answering");
        expect(error.message).toContain("The worktree /worktrees/app-1 on LinkMini was kept");
        expect(harness.settled).toEqual([]);
      }),
    );

    it.effect("reports a branch the other machine could not open, with the pushed commit", () =>
      Effect.gen(function* () {
        const error = yield* makeHarness({ openBranch: "fails" }).failed();
        expect(error.message).toContain("origin has no branch feature/login.");
        expect(error.message).toContain("committed and pushed to origin/feature/login");
      }),
    );
  });

  describe("retrying with the same clientRequestId", () => {
    const launchesOf = (harness: ReturnType<typeof makeHarness>) =>
      harness.forwarded.filter((call) => call.tool === "t3_thread_launch");
    const opensOf = (harness: ReturnType<typeof makeHarness>) =>
      harness.forwarded.filter((call) => call.tool === "t3_worktree_open_branch");

    it.effect("carries on after a failed launch with what it pushed, and plans nothing again", () =>
      Effect.gen(function* () {
        // The repository names no default, so a second plan takes the pushed branch for the default.
        const harness = makeHarness({ defaultKnown: false, launchFails: true });
        const result = yield* harness.session((handOff) =>
          Effect.gen(function* () {
            const failed = yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
            expect(failed.message).toContain("The linked environment stopped answering.");
            harness.options.launchFails = false;
            return yield* handOff({ clientRequestId: "request-1" });
          }),
        );
        expect(result).toMatchObject({
          branch: "handoff/fix-the-flaky-login",
          pushedCommit: tip,
          worktreePath: "/worktrees/app-1",
          sourceSettles: "at_turn_end",
        });
        expect(gitWrites(harness.log)).toEqual([
          "upload",
          "git createRef handoff/fix-the-flaky-login",
          "git commit_push",
        ]);
        // Nothing had been launched, so the worktree was checked again before it was repeated.
        const opens = opensOf(harness);
        expect(opens).toHaveLength(2);
        expect(opens[1]).toEqual(opens[0]);
        const launches = launchesOf(harness);
        expect(launches).toHaveLength(2);
        expect(launches[1]).toEqual(launches[0]);
        expect(harness.settled).toHaveLength(1);
      }),
    );

    it.effect("recovers a launch whose reply was lost, though the worktree has changed since", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ launchLosesReply: true });
        const result = yield* harness.session((handOff) =>
          Effect.gen(function* () {
            yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
            // The agent there has been working in it, so opening the branch again would refuse.
            harness.options.launchLosesReply = false;
            harness.options.openBranch = "dirty";
            return yield* handOff({ clientRequestId: "request-1" });
          }),
        );
        expect(result).toMatchObject({
          threadId: "thread:linkmini-1",
          worktreePath: "/worktrees/app-1",
          sourceSettles: "at_turn_end",
        });
        // The launch that went through is found, not repeated, and the worktree is not looked at.
        expect(harness.pushes).toHaveLength(1);
        expect(opensOf(harness)).toHaveLength(1);
        expect(launchesOf(harness)).toHaveLength(1);
        expect(harness.forwarded.map((call) => call.tool)).toContain("t3_thread_launch_lookup");
        expect(harness.settled).toHaveLength(1);
      }),
    );

    it.effect("does not launch again when it cannot tell whether the launch went through", () =>
      Effect.gen(function* () {
        const cases = [
          { lookup: "missing", expected: "does not have t3_thread_launch_lookup" },
          { lookup: "fails", expected: "Whether the launch went through is not known" },
        ] as const;
        for (const { lookup, expected } of cases) {
          const harness = makeHarness({ launchLosesReply: true });
          yield* harness.session((handOff) =>
            Effect.gen(function* () {
              yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
              harness.options.lookup = lookup;
              const refused = yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
              expect(refused.message).toContain(expected);
            }),
          );
          expect(launchesOf(harness)).toHaveLength(1);
          expect(harness.settled).toEqual([]);
        }
      }),
    );

    it.effect("repeats only the step that failed", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ pushFails: "after-commit" });
        yield* harness.session((handOff) =>
          Effect.gen(function* () {
            const refused = yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
            expect(refused.message).toContain("Its WIP commit was not pushed.");
            delete harness.options.pushFails;
            harness.options.nothingToCommit = true;
            yield* handOff({ clientRequestId: "request-1" });
          }),
        );
        // The conversation went up once, and the commit made before the push is still named.
        expect(harness.uploads).toHaveLength(1);
        expect(launchesOf(harness)[0]?.params.message).toContain("includes a WIP commit");
      }),
    );

    it.effect("does not launch in a worktree that is not the one it opened", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ launchFails: true });
        yield* harness.session((handOff) =>
          Effect.gen(function* () {
            yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
            // Nothing was launched, and the checkout that held the branch has moved to another.
            harness.options.launchFails = false;
            harness.options.openBranch = "elsewhere";
            const refused = yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
            expect(refused.message).toContain("/worktrees/app-2");
            expect(refused.message).toContain("not launched again");
          }),
        );
        expect(launchesOf(harness)).toHaveLength(1);
        expect(harness.settled).toEqual([]);
      }),
    );

    it.effect("does not launch in a worktree that changed after a launch that never arrived", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ launchFails: true });
        yield* harness.session((handOff) =>
          Effect.gen(function* () {
            yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
            harness.options.launchFails = false;
            harness.options.openBranch = "dirty";
            const refused = yield* handOff({ clientRequestId: "request-1" }).pipe(Effect.flip);
            expect(refused.message).toContain("uncommitted changes");
          }),
        );
        expect(launchesOf(harness)).toHaveLength(1);
        expect(harness.settled).toEqual([]);
      }),
    );

    it.effect("refuses an id that was used for a different hand-off", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ launchFails: true });
        yield* harness.session((handOff) =>
          Effect.gen(function* () {
            yield* handOff({ clientRequestId: "request-1", message: "Fix the tests" }).pipe(
              Effect.flip,
            );
            const before = harness.forwarded.length;
            const refused = yield* handOff({
              clientRequestId: "request-1",
              message: "Do something else",
            }).pipe(Effect.flip);
            expect(refused.code).toBe("invalid_request");
            expect(refused.message).toContain("different hand-off");
            expect(harness.forwarded).toHaveLength(before);
          }),
        );
        expect(harness.pushes).toHaveLength(1);
      }),
    );

    it.effect("refuses an id a hand-off of another thread is still preparing", () =>
      Effect.gen(function* () {
        const begun = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = makeHarness({ firstUploadHeld: { begun, release } });
        const result = yield* harness.session((handOff) =>
          Effect.gen(function* () {
            const first = yield* handOff({
              clientRequestId: "request-1",
              threadId: sourceThread,
            }).pipe(Effect.forkChild);
            // The first is part-way through its upload when a second thread asks with the same id.
            yield* Deferred.await(begun);
            const refused = yield* handOff({
              clientRequestId: "request-1",
              threadId: otherThread,
            }).pipe(Effect.flip);
            expect(refused.code).toBe("invalid_request");
            expect(refused.message).toContain("different hand-off");
            yield* Deferred.succeed(release, undefined);
            return yield* Fiber.join(first);
          }),
        );
        expect(result.threadId).toBe("thread:linkmini-1");
        expect(harness.uploads).toHaveLength(1);
        expect(launchesOf(harness)).toHaveLength(1);
        expect(harness.settled.map((entry) => entry.threadId)).toEqual([sourceThread]);
      }),
    );

    it.effect("forgets an attempt after six hours, and the oldest past two hundred", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ launchFails: true });
        yield* harness.session((handOff) =>
          Effect.gen(function* () {
            const attempt = (id: string) => handOff({ clientRequestId: id }).pipe(Effect.flip);
            // A remembered attempt does not upload the conversation again; a forgotten one does.
            yield* attempt("request-0");
            yield* attempt("request-0");
            expect(harness.uploads).toHaveLength(1);
            yield* TestClock.adjust(Duration.hours(7));
            yield* attempt("request-0");
            expect(harness.uploads).toHaveLength(2);
            for (let index = 1; index <= 200; index += 1) yield* attempt(`request-${index}`);
            const uploaded = harness.uploads.length;
            yield* attempt("request-200");
            expect(harness.uploads).toHaveLength(uploaded);
            yield* attempt("request-0");
            expect(harness.uploads).toHaveLength(uploaded + 1);
          }),
        );
      }),
    );
  });

  describe("settling the thread", () => {
    it.effect("settles the calling thread when its turn ends", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const result = yield* harness.run();
        expect(result.sourceSettles).toBe("at_turn_end");
        expect(harness.settled).toEqual([{ threadId: sourceThread, byOwnAgent: true }]);
      }),
    );

    it.effect("settles another thread that is idle at once", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ other: true });
        const result = yield* harness.run();
        expect(result.sourceSettles).toBe("now");
        expect(harness.settled).toEqual([{ threadId: sourceThread, byOwnAgent: false }]);
      }),
    );

    it.effect("still reports the hand-off when settling fails", () =>
      Effect.gen(function* () {
        const result = yield* makeHarness({ settleFails: true }).run();
        expect(result.sourceSettles).toBe("failed");
        expect(result.threadId).toBe("thread:linkmini-1");
      }),
    );
  });

  describe("without code", () => {
    it.effect(
      "hands over only the conversation from a thread with no project, to a scratch folder",
      () =>
        Effect.gen(function* () {
          const harness = makeHarness({ scratch: true });
          const result = yield* harness.run();
          expect(gitWrites(harness.log)).toEqual(["upload"]);
          const launch = harness.forwarded.find((call) => call.tool === "t3_thread_launch");
          expect(launch?.params.scratch).toBe(true);
          expect(launch?.params.workspaceStrategy).toBeUndefined();
          expect(launch?.params.message).toContain(
            "No code was carried over: this thread has no project.",
          );
          expect(result).toMatchObject({ branch: null, pushedCommit: null, worktreePath: null });
        }),
    );

    it.effect("needs the project named when the repository cannot be matched", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ noRemote: true });
        const error = yield* harness.failed();
        expect(error.code).toBe("target_required");
        expect(error.message).toContain("t3_project_list with environmentId environment-linkmini");
        const named = makeHarness({ noRemote: true });
        const result = yield* named.run({ projectId: ProjectId.make("project:linkmini") });
        expect(gitWrites(named.log)).toEqual(["upload"]);
        expect(result.projectId).toBe("project:linkmini");
        expect(
          named.forwarded.find((call) => call.tool === "t3_thread_launch")?.params.message,
        ).toContain("the project has no git remote");
      }),
    );

    it.effect("launches in the project's own checkout when the branch has nothing to carry", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          status: {
            refName: "main",
            isDefaultRef: true,
            hasWorkingTreeChanges: false,
            aheadCount: 0,
          },
        });
        const result = yield* harness.run();
        expect(gitWrites(harness.log)).toEqual(["upload"]);
        expect(result).toMatchObject({ pushedCommit: null, worktreePath: null });
        expect(
          harness.forwarded.find((call) => call.tool === "t3_thread_launch")?.params
            .workspaceStrategy,
        ).toBeUndefined();
      }),
    );
  });
});
