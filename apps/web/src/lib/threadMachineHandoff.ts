import {
  buildHandoffNote,
  handoffCommitMessage,
  resolveHandoffDraftBase,
  type HandoffReady,
  type HandoffStep,
} from "@t3tools/client-runtime/thread-machine-handoff";
import type { ModelSelection } from "@t3tools/contracts";

import type { DraftId } from "../composerDraftStore";
import { formatBytes } from "./formatBytes";

export type HandoffStepState = "running" | "done";

export interface HandoffDraftRequest {
  readonly note: string;
  readonly conversation: File | null;
  /** The ref the new worktree starts from, or null to leave the draft on its defaults. */
  readonly baseRef: string | null;
  readonly modelSelection: ModelSelection | null;
}

/** Every call throws an `Error` with a message the user can read when it fails. */
export interface ThreadMachineHandoffIo {
  readonly readConversation: () => Promise<File>;
  readonly createBranch: (name: string) => Promise<void>;
  readonly commitAndPush: (input: {
    readonly commitMessage: string;
    readonly onPhase: (phase: "commit" | "push") => void;
  }) => Promise<{ readonly upstreamBranch: string | undefined }>;
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
 * the read-only conversation first, then the source's git, then the draft that nothing yet
 * depends on.
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
    let baseRef: string | null = null;
    const { code } = plan;
    if (code.kind === "carry") {
      if (code.createBranch) {
        start("branch");
        await io.createBranch(code.branch);
      }
      start(code.commit === null ? "push" : "commit");
      // The server starts the commit phase only when it has something to commit, so this also
      // knows of changes that appeared after the plan was made.
      let committed = false;
      const pushed = await io.commitAndPush({
        commitMessage: code.commit?.message ?? handoffCommitMessage(plan.target.label),
        onPhase: (phase) => {
          start(phase);
          committed ||= phase === "commit";
          leftLocalCommit = phase === "push" && committed;
        },
      });
      leftLocalCommit = false;
      baseRef = resolveHandoffDraftBase(plan, pushed.upstreamBranch);
    }
    start("draft");
    const draftId = await io.openDraft({
      note: buildHandoffNote({
        title: input.title,
        sourceLabel: input.sourceLabel,
        code,
        pushedBase: baseRef,
        threadLink: input.threadLink,
        transcriptAttached: conversation !== null,
      }),
      conversation,
      baseRef,
      modelSelection: plan.modelSelection,
    });
    finish();
    return { ok: true, draftId };
  } catch (error) {
    return {
      ok: false,
      step: lastStarted,
      message: error instanceof Error ? error.message : "An error occurred.",
      leftLocalCommit,
    };
  }
}
