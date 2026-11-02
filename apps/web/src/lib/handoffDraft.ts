import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";

import {
  type ComposerFileAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import type { NewThreadHandler } from "../hooks/useHandleNewThread";
import {
  type PendingMachineHandoff,
  useThreadMachineHandoffStore,
} from "../threadMachineHandoffStore";
import type { HandoffDraftRequest } from "./threadMachineHandoff";
import { randomUUID } from "./utils";

function conversationAttachment(file: File): ComposerFileAttachment {
  return {
    type: "file",
    id: randomUUID(),
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

/**
 * Opens the draft the handed-off thread continues in: its worktree starts from the pushed branch,
 * the note is the prompt, and the conversation is attached after it. The user adds the
 * instructions and sends.
 */
export async function openHandoffDraft(input: {
  readonly newThread: NewThreadHandler;
  readonly project: ScopedProjectRef;
  readonly request: HandoffDraftRequest;
  readonly pending: Omit<PendingMachineHandoff, "target" | "createdAt">;
}): Promise<DraftId> {
  const { request } = input;
  const opened = await input.newThread(input.project, {
    ...(request.baseRef === null
      ? {}
      : {
          branch: request.baseRef,
          worktreePath: null,
          envMode: "worktree",
          startFromOrigin: true,
        }),
    prompt: request.note,
  });
  if (opened === null) throw new Error(`Could not open a draft on ${input.pending.targetLabel}.`);
  const drafts = useComposerDraftStore.getState();
  // The machine was chosen on purpose; automatic balancing must not move the draft elsewhere.
  drafts.setDraftThreadContext(opened.draftId, {
    environmentSelection: "manual",
    loadBalancedEnvironmentId: null,
  });
  if (request.modelSelection !== null) {
    drafts.setModelSelection(opened.draftId, request.modelSelection, {
      explicit: true,
      replaceOptions: true,
    });
  }
  if (request.conversation !== null) {
    drafts.addFiles(opened.draftId, [conversationAttachment(request.conversation)], {
      appendReference: true,
    });
  }
  useThreadMachineHandoffStore.getState().remember(opened.draftId, {
    ...input.pending,
    target: scopeThreadRef(input.project.environmentId, opened.threadId),
    createdAt: new Date().toISOString(),
  });
  return opened.draftId;
}
