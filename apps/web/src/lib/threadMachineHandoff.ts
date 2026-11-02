import {
  buildHandoffNote,
  handoffCommitMessage,
  isSameHandoffCode,
  resolveHandoffComparisonBase,
  resolveHandoffPushed,
  type HandoffPushed,
  type HandoffReady,
  type HandoffStep,
  type ThreadMachineHandoffPlan,
} from "@t3tools/client-runtime/thread-machine-handoff";
import type { ModelSelection } from "@t3tools/contracts";

import type { DraftId } from "../composerDraftStore";
import { formatBytes } from "./formatBytes";

export type HandoffStepState = "running" | "done";

export interface HandoffDraftRequest {
  readonly note: string;
  readonly conversation: File | null;
  /** The worktree the draft continues in, or null to leave the draft on its defaults. */
  readonly worktree: { readonly path: string; readonly branch: string } | null;
  readonly modelSelection: ModelSelection | null;
}

/** Every call throws an `Error` with a message the user can read when it fails. */
export interface ThreadMachineHandoffIo {
  readonly readConversation: () => Promise<File>;
  /** The plan as the checkout stands now, to see that the one shown still holds. */
  readonly replan: () => Promise<ThreadMachineHandoffPlan>;
  /** The newest commit of the source's branch before anything is done to it, if it has one. */
  readonly readTip: () => Promise<string | null>;
  readonly createBranch: (name: string) => Promise<void>;
  readonly commitAndPush: (input: {
    readonly commitMessage: string;
    readonly onPhase: (phase: "commit" | "push") => void;
  }) => Promise<{
    readonly upstreamBranch: string | undefined;
    /** The commit this made, when it made one. */
    readonly commitSha: string | undefined;
  }>;
  /** Puts the pushed branch on a worktree of the target machine, holding the pushed commit. */
  readonly prepareTarget: (input: {
    readonly pushed: Extract<HandoffPushed, { ok: true }>;
    readonly comparisonBase: string | null;
    readonly expectedCommit: string | null;
    readonly onPhase: (phase: "fetch" | "worktree") => void;
  }) => Promise<{ readonly worktreePath: string; readonly branch: string }>;
  readonly removeTargetWorktree: (path: string) => Promise<void>;
  readonly openDraft: (request: HandoffDraftRequest) => Promise<DraftId>;
}

export type ThreadMachineHandoffResult =
  | { readonly ok: true; readonly draftId: DraftId }
  | {
      readonly ok: false;
      readonly step: HandoffStep;
      readonly message: string;
      /** The WIP commit is in the source checkout, but never reached the remote. */
      readonly leftLocalCommit: boolean;
    };

/**
 * Hands a thread to another machine in the order that leaves the least behind when a step fails:
 * the read-only conversation first, then the source's git, then the target's, then the draft that
 * nothing yet depends on.
 */
export async function runThreadMachineHandoff(input: {
  readonly plan: HandoffReady;
  readonly title: string;
  readonly sourceLabel: string;
  readonly threadLink: string | null;
  readonly io: ThreadMachineHandoffIo;
  readonly onStep: (step: HandoffStep, state: HandoffStepState) => void;
}): Promise<ThreadMachineHandoffResult> {
  const { plan, io, onStep } = input;
  let running: HandoffStep | null = null;
  let lastStarted: HandoffStep = "conversation";
  let leftLocalCommit = false;
  const finish = () => {
    if (running !== null) onStep(running, "done");
    running = null;
  };
  const start = (step: HandoffStep) => {
    if (running === step) return;
    finish();
    running = step;
    lastStarted = step;
    onStep(step, "running");
  };
  try {
    let conversation: File | null = null;
    if (plan.transcript.attach) {
      start("conversation");
      conversation = await io.readConversation();
      if (plan.transcript.maxBytes !== null && conversation.size > plan.transcript.maxBytes) {
        throw new Error(
          `The conversation is ${formatBytes(conversation.size)}, more than ${plan.target.label} accepts as an attachment (${formatBytes(plan.transcript.maxBytes)}).`,
        );
      }
    }
    let remoteRef: string | null = null;
    let worktree: HandoffDraftRequest["worktree"] = null;
    const { code } = plan;
    if (code.kind === "carry") {
      start(code.createBranch ? "branch" : code.commit === null ? "push" : "commit");
      // The dialog read the checkout earlier; it commits whatever is there now.
      const fresh = await io.replan();
      if (fresh.kind === "blocked") throw new Error(fresh.message);
      if (!isSameHandoffCode(code, fresh.code)) {
        throw new Error(
          "The checkout changed since this was planned. Nothing was done; the steps shown now are updated.",
        );
      }
      // What is pushed is this commit, or the one made on top of it.
      const tip = await io.readTip();
      if (code.createBranch) {
        start("branch");
        await io.createBranch(code.branch);
      }
      start(code.commit === null ? "push" : "commit");
      // The server starts the commit phase only when it has something to commit, so this also
      // knows of changes that appeared after the plan was made.
      let committed = false;
      const pushedTo = await io.commitAndPush({
        commitMessage: code.commit?.message ?? handoffCommitMessage(plan.target.label),
        onPhase: (phase) => {
          start(phase);
          committed ||= phase === "commit";
          leftLocalCommit = phase === "push" && committed;
        },
      });
      leftLocalCommit = false;
      // A push the remote already had reports no phase of its own.
      start("push");
      const pushed = resolveHandoffPushed(plan, pushedTo.upstreamBranch);
      if (!pushed.ok) throw new Error(pushed.message);
      remoteRef = pushed.remoteRef;
      const prepared = await io.prepareTarget({
        pushed,
        comparisonBase: resolveHandoffComparisonBase(code.comparisonBase, pushed),
        expectedCommit: pushedTo.commitSha ?? tip,
        onPhase: start,
      });
      worktree = { path: prepared.worktreePath, branch: prepared.branch };
    }
    start("draft");
    try {
      const draftId = await io.openDraft({
        note: buildHandoffNote({
          title: input.title,
          sourceLabel: input.sourceLabel,
          code,
          remoteRef,
          threadLink: input.threadLink,
          transcriptAttached: conversation !== null,
        }),
        conversation,
        worktree,
        modelSelection: plan.modelSelection,
      });
      finish();
      return { ok: true, draftId };
    } catch (error) {
      // Nothing uses the worktree yet, and a retry makes a fresh one.
      if (worktree !== null) await io.removeTargetWorktree(worktree.path).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return {
      ok: false,
      step: lastStarted,
      message: error instanceof Error ? error.message : "An error occurred.",
      leftLocalCommit,
    };
  }
}
