import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { threadWaitErrorMessage } from "../components/threadWait.logic";
import { requestThreadWaitBlocker } from "../components/threadWaitPicker.state";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadWaitEnvironment } from "../state/threadWaits";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({ type: "error", title, description: threadWaitErrorMessage(error) }),
  );
}

const clearWait = (threadRef: ScopedThreadRef) =>
  runAtomCommand(
    appAtomRegistry,
    threadWaitEnvironment.clearThreadWait,
    { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, wake: true } },
    { reportFailure: false },
  );

/** Snoozes `threadRef` until `blockerThreadId` is done, with the usual snooze undo notice. */
export async function waitOnThread(threadRef: ScopedThreadRef, blockerThreadId: ThreadId) {
  const claim = ThreadUndo.begin("snooze", scopedThreadKey(threadRef));
  const result = await runAtomCommand(
    appAtomRegistry,
    threadWaitEnvironment.setThreadWait,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, blockerThreadId },
    },
    { reportFailure: false },
  );
  if (result._tag !== "Success") {
    claim.finish();
    if (!isAtomCommandInterrupted(result)) {
      failureToast("Failed to snooze thread", squashAtomCommandFailure(result));
    }
    return;
  }
  showThreadUndoNotice({
    action: "Snoozed",
    claim,
    undo: () => clearWait(threadRef),
    failureTitle: "Failed to stop waiting",
  });
}

export async function pickThreadAndWait(threadRef: ScopedThreadRef) {
  const blockerThreadId = await requestThreadWaitBlocker(threadRef);
  if (blockerThreadId !== null) await waitOnThread(threadRef, blockerThreadId);
}

/** Wakes `threadRef` and drops its wait. */
export async function stopWaiting(threadRef: ScopedThreadRef) {
  ThreadUndo.invalidate("snooze", scopedThreadKey(threadRef));
  const result = await clearWait(threadRef);
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    failureToast("Failed to stop waiting", squashAtomCommandFailure(result));
  }
}
