import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadContinueOnMachineResult,
  type WorktreeOpenBranchResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpServer } from "effect/ai";

import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ThreadMachineHandoff from "../../../peer/ThreadMachineHandoff.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as WorktreeOpenBranch from "../../WorktreeOpenBranch.ts";
import * as MachineHandoffHandlers from "./handlers.ts";
import { MachineHandoffToolkit } from "./tools.ts";

const here = EnvironmentId.make("environment-laptop");
const there = EnvironmentId.make("environment-linkmini");
const threadId = ThreadId.make("thread:caller");
const projectId = ProjectId.make("project:app");

const opened = {
  worktreePath: "/worktrees/app-1",
  branch: "feature",
  remote: "origin",
  head: "a".repeat(40),
  created: true,
} satisfies WorktreeOpenBranchResult;

const continued = {
  environmentId: there,
  threadId: ThreadId.make("thread:there"),
  link: "<t3-thread://v2/environment-linkmini/thread:there>",
  projectId,
  branch: null,
  pushedCommit: null,
  worktreePath: null,
  sourceSettles: "at_turn_end",
} satisfies ThreadContinueOnMachineResult;

type Caller = "thread" | "linked" | "read-only";

const scopeOf = (caller: Caller): McpInvocationContext.McpInvocationScope => ({
  environmentId: here,
  requestNamespace: `namespace:${caller}`,
  thread:
    caller === "thread"
      ? {
          threadId,
          providerSessionId: "provider:caller",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
  client:
    caller === "thread"
      ? undefined
      : {
          sessionId: "session:client",
          label: "Client",
          access: caller === "read-only" ? "read-only" : "auto",
          linked: caller === "linked",
        },
  capabilities: new Set(["orchestration", "worktree"]),
  issuedAt: 0,
  linkedEnvironments: true,
});

/** Runs a tool through its handler as `caller`, with the services it calls recorded. */
const callTool = (
  caller: Caller,
  name: "t3_worktree_open_branch" | "t3_thread_continue_on_machine",
  params: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (entry: string) => Ref.update(calls, (seen) => [...seen, entry]);
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scopeOf(caller)),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(WorktreeOpenBranch.WorktreeOpenBranch)({
        open: () => record("open here").pipe(Effect.as(opened)),
      }),
      Layer.mock(ThreadMachineHandoff.ThreadMachineHandoff)({
        continueOnMachine: () => record("continue").pipe(Effect.as(continued)),
      }),
      Layer.mock(PeerForwarding.PeerForwarding)({
        call: ((_scope: unknown, tool: { readonly name: string }, environmentId: string) =>
          record(`forward ${tool.name} to ${environmentId}`).pipe(Effect.as(opened))) as never,
      }),
    );
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* MachineHandoffToolkit;
      const results = yield* toolkit
        .handle(name, params as never)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.result;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(MachineHandoffHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
    return { result, calls: yield* Ref.get(calls) };
  });

it.effect("opens a branch for a linked caller, which may stage what its own thread needs", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool("linked", "t3_worktree_open_branch", {
      projectId,
      branch: "feature",
    });
    expect(result).toEqual(opened);
    expect(calls).toEqual(["open here"]);
  }),
);

it.effect("does not open a branch for a client approved for read-only access", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool("read-only", "t3_worktree_open_branch", {
      projectId,
      branch: "feature",
    });
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
  }),
);

it.effect("opens a branch in a linked environment there, not here", () =>
  Effect.gen(function* () {
    const { calls } = yield* callTool("thread", "t3_worktree_open_branch", {
      environmentId: there,
      projectId,
      branch: "feature",
    });
    expect(calls).toEqual(["forward t3_worktree_open_branch to environment-linkmini"]);
  }),
);

it.effect("continues a thread for the thread that asks", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool("thread", "t3_thread_continue_on_machine", {
      environmentId: there,
    });
    expect(result).toEqual(continued);
    expect(calls).toEqual(["continue"]);
  }),
);

it.effect("does not continue a thread for a client approved for read-only access", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* callTool("read-only", "t3_thread_continue_on_machine", {
      environmentId: there,
      threadId,
    });
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
  }),
);

it.effect(
  "advertises both tools, naming the machine to move to for the one that moves a thread",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const advertised = new Map(server.tools.map(({ tool }) => [tool.name, tool.inputSchema]));
      expect([...advertised.keys()].toSorted()).toEqual([
        "t3_thread_continue_on_machine",
        "t3_worktree_open_branch",
      ]);
      // Moving a thread always names a machine; opening a branch acts here unless it names one.
      expect(advertised.get("t3_thread_continue_on_machine")).toMatchObject({
        required: expect.arrayContaining(["environmentId"]),
      });
      expect(advertised.get("t3_worktree_open_branch")).toMatchObject({
        required: expect.arrayContaining(["projectId", "branch"]),
      });
      expect(advertised.get("t3_worktree_open_branch")).not.toMatchObject({
        required: expect.arrayContaining(["environmentId"]),
      });
    }).pipe(
      Effect.provide(
        McpHttpServer.toolkitRegistration(MachineHandoffToolkit, MachineHandoffHandlers.layer).pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagement.ThreadManagementService)({}),
              Layer.mock(WorktreeOpenBranch.WorktreeOpenBranch)({}),
              Layer.mock(ThreadMachineHandoff.ThreadMachineHandoff)({}),
            ),
          ),
        ),
      ),
    ),
);
