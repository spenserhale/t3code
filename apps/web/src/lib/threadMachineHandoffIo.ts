import {
  explainHandoffGitFailure,
  type HandoffReady,
  type ThreadMachineHandoffPlan,
} from "@t3tools/client-runtime/thread-machine-handoff";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentRequestInvalidError,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { NewThreadHandler } from "../hooks/useHandleNewThread";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { reviewEnvironment } from "../state/review";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { vcsActionManager, vcsEnvironment } from "../state/vcs";
import { openHandoffDraft } from "./handoffDraft";
import { readAllRefPages } from "./handoffRefs";
import { prepareHandoffTargetWorktree, type HandoffTargetGitIo } from "./handoffTargetBranch";
import { threadContextAttachment } from "./threadContextAttachment";
import type { ThreadMachineHandoffIo } from "./threadMachineHandoff";
import { randomUUID } from "./utils";

const isRequestInvalid = Schema.is(EnvironmentRequestInvalidError);

function failureMessage(result: AtomCommandResult<unknown, unknown>, fallback: string): string {
  if (result._tag === "Success") return fallback;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** Requests to the target machine's checkout of the project, which is where git runs. */
function createTargetGitIo(environmentId: EnvironmentId, cwd: string): HandoffTargetGitIo {
  const run = async <A>(
    description: string,
    command: () => Promise<AtomCommandResult<A, unknown>>,
  ): Promise<A> => {
    const result = await command();
    if (result._tag === "Success") return result.value;
    throw new Error(failureMessage(result, `${description} failed.`));
  };
  return {
    refresh: async () => {
      await runAtomCommand(
        appAtomRegistry,
        vcsEnvironment.refreshStatus,
        { environmentId, input: { cwd } },
        { reportFailure: false },
      );
    },
    listRefs: async (query) =>
      readAllRefPages((cursor) =>
        run("Reading the branches", () =>
          runAtomCommand(
            appAtomRegistry,
            vcsEnvironment.readRefs,
            {
              environmentId,
              input: {
                cwd,
                query,
                includeMatchingRemoteRefs: true,
                limit: 200,
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
            { reportFailure: false },
          ),
        ),
      ),
    createWorktree: async (request) => {
      const created = await run("Creating the worktree", () =>
        runAtomCommand(
          appAtomRegistry,
          vcsEnvironment.createWorktree,
          { environmentId, input: { cwd, path: null, ...request } },
          { reportFailure: false },
        ),
      );
      return { path: created.worktree.path };
    },
    pull: async (worktreeCwd) => {
      const pulled = await run("Updating the branch", () =>
        runAtomCommand(
          appAtomRegistry,
          vcsEnvironment.pull,
          { environmentId, input: { cwd: worktreeCwd } },
          { reportFailure: false },
        ),
      );
      return { upstreamRef: pulled.upstreamRef };
    },
    status: async (worktreeCwd) => {
      const status = await run("Reading the branch", () =>
        runAtomCommand(
          appAtomRegistry,
          vcsEnvironment.refreshStatus,
          { environmentId, input: { cwd: worktreeCwd } },
          { reportFailure: false },
        ),
      );
      return {
        hasUpstream: status.hasUpstream,
        aheadCount: status.aheadCount,
        behindCount: status.behindCount,
        baseRef: status.branchChanges?.baseRef ?? null,
      };
    },
    commits: async (worktreeCwd) => {
      const read = await run("Reading the commits", () =>
        runAtomCommand(
          appAtomRegistry,
          reviewEnvironment.readBranchCommits,
          { environmentId, input: { cwd: worktreeCwd } },
          { reportFailure: false },
        ),
      );
      return { shas: read.commits.map((commit) => commit.sha), truncated: read.truncated };
    },
    removeWorktree: async (path) => {
      await run("Removing the worktree", () =>
        runAtomCommand(
          appAtomRegistry,
          vcsEnvironment.removeWorktree,
          { environmentId, input: { cwd, path, force: true } },
          { reportFailure: false },
        ),
      );
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** The server-side wiring of a handoff: each call is one request to one machine. */
export function createThreadMachineHandoffIo(input: {
  readonly plan: HandoffReady;
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">;
  /** The checkout the thread works in. */
  readonly cwd: string;
  readonly sourceLabel: string;
  readonly newThread: NewThreadHandler;
  readonly openScratchProject: (environmentId: EnvironmentId) => Promise<EnvironmentProject | null>;
  /** The plan from a fresh read of the checkout. */
  readonly replan: () => Promise<ThreadMachineHandoffPlan>;
}): ThreadMachineHandoffIo {
  const { plan, thread, cwd } = input;
  const source = { environmentId: thread.environmentId, cwd };
  return {
    replan: input.replan,
    readConversation: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        orchestrationEnvironment.threadTranscript,
        { environmentId: thread.environmentId, input: { threadId: thread.id } },
        { reportFailure: false },
      );
      if (result._tag === "Success") {
        return threadContextAttachment(thread.environmentId, result.value);
      }
      const error = squashAtomCommandFailure(result);
      throw new Error(
        isRequestInvalid(error) && error.reason === "thread_transcript_too_large"
          ? "This thread is too large to attach as a file."
          : failureMessage(result, "Could not read this thread's conversation."),
      );
    },
    readTip: async () => {
      const read = await runAtomCommand(
        appAtomRegistry,
        reviewEnvironment.readBranchCommits,
        { environmentId: source.environmentId, input: { cwd } },
        { reportFailure: false },
      );
      if (read._tag !== "Success") {
        throw new Error(failureMessage(read, "Could not read this checkout's latest commit."));
      }
      return read.value.commits[0]?.sha ?? null;
    },
    createBranch: async (name) => {
      const created = await runAtomCommand(
        appAtomRegistry,
        vcsEnvironment.createRef,
        { environmentId: source.environmentId, input: { cwd, refName: name, switchRef: true } },
        { reportFailure: false },
      );
      if (created._tag !== "Success") {
        throw new Error(failureMessage(created, `Could not create the branch ${name}.`));
      }
      // The checkout moved to the new branch; the thread follows it. Best effort: the work is safe either way.
      await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.updateMetadata,
        {
          environmentId: source.environmentId,
          input: { threadId: thread.id, branch: created.value.refName },
        },
        { reportFailure: false },
      );
    },
    commitAndPush: async ({ commitMessage, onPhase }) => {
      let failure: string | null = null;
      const result = await runAtomCommand(
        appAtomRegistry,
        vcsActionManager.runStackedAction(source),
        {
          actionId: randomUUID(),
          action: "commit_push",
          commitMessage,
          threadId: thread.id,
          onProgress: (event) => {
            if (
              event.kind === "phase_started" &&
              (event.phase === "commit" || event.phase === "push")
            ) {
              onPhase(event.phase);
            } else if (event.kind === "action_failed") {
              failure = event.message;
            }
          },
        },
        { reportFailure: false },
      );
      if (result._tag !== "Success") {
        throw new Error(
          explainHandoffGitFailure(failure ?? failureMessage(result, "Could not push the branch.")),
        );
      }
      return {
        upstreamBranch: result.value.push.upstreamBranch,
        commitSha: result.value.commit.commitSha,
      };
    },
    prepareTarget: async ({ pushed, comparisonBase, expectedCommit, onPhase }) => {
      if (plan.target.cwd === null) {
        throw new Error(`${plan.target.label} has no folder for this project.`);
      }
      return prepareHandoffTargetWorktree({
        io: createTargetGitIo(plan.target.environmentId, plan.target.cwd),
        targetLabel: plan.target.label,
        branch: pushed.branch,
        remote: pushed.remote,
        comparisonBase,
        expectedCommit,
        onPhase,
      });
    },
    removeTargetWorktree: async (path) => {
      if (plan.target.cwd === null) return;
      await createTargetGitIo(plan.target.environmentId, plan.target.cwd).removeWorktree(path);
    },
    openDraft: async (request) => {
      const project: ScopedProjectRef | null =
        plan.target.project ??
        (await input
          .openScratchProject(plan.target.environmentId)
          .then((scratch) =>
            scratch === null ? null : scopeProjectRef(scratch.environmentId, scratch.id),
          ));
      if (project === null) {
        throw new Error(`Could not open a project-less folder on ${plan.target.label}.`);
      }
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId);
      return openHandoffDraft({
        newThread: input.newThread,
        project,
        request: {
          ...request,
          modelSelection:
            request.modelSelection ??
            (config === undefined
              ? null
              : resolveProjectDefaultProviderModelSelection(
                  config.providers,
                  config.settings,
                  project.projectId,
                )),
        },
        pending: {
          source: { environmentId: thread.environmentId, threadId: thread.id },
          title: thread.title,
          sourceLabel: input.sourceLabel,
          targetLabel: plan.target.label,
        },
      });
    },
  };
}
