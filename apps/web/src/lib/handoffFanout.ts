import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadMachineHandoffStore } from "../threadMachineHandoffStore";

/**
 * A multi-model send starts new threads and never sends as the draft's own, so a handoff draft
 * has to be told which thread carries it: the first one that starts. Until the send is over it
 * also stays a handoff though the composer is empty.
 */
export function trackHandoffFanout(draftId: string | null) {
  const store = useThreadMachineHandoffStore.getState();
  if (draftId !== null) store.beginSend(draftId);
  return {
    started(environmentId: EnvironmentId, threadId: ThreadId) {
      if (draftId === null) return;
      const entry = useThreadMachineHandoffStore.getState().byDraftId[draftId];
      if (entry === undefined || entry.sentAs !== undefined) return;
      useThreadMachineHandoffStore
        .getState()
        .retarget(draftId, { sentAs: scopeThreadRef(environmentId, threadId) });
    },
    end() {
      if (draftId !== null) useThreadMachineHandoffStore.getState().endSend(draftId);
    },
  };
}
