import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, waitForThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import type { PendingMachineHandoff } from "../threadMachineHandoffStore";
import type { HandoffSettleOutcome } from "./threadMachineHandoffSettle";

/** The failures already shown, so a retry that fails again does not toast again. */
const reportedFailures = new Set<string>();

/**
 * Settles the thread a machine handoff came from, and offers to take that back. A failure leaves
 * the handoff to be tried again: the source may be busy, away, or about to be granted access.
 */
export async function settleHandoffSource(
  pending: PendingMachineHandoff,
): Promise<HandoffSettleOutcome> {
  const { source } = pending;
  // The shell can trail the connection; a thread that is still missing then was deleted.
  if (readThreadShell(source) === null && !(await waitForThreadShell(source))) return "gone";
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.settle,
    { environmentId: source.environmentId, input: { threadId: source.threadId } },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
    reportedFailures.delete(scopedThreadKey(pending.source));
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Settled “${pending.title}”`,
        description: `Continued on ${pending.targetLabel}.`,
        timeout: 10_000,
        actionProps: {
          children: "Undo",
          onClick: () => {
            void runAtomCommand(
              appAtomRegistry,
              threadEnvironment.unsettle,
              {
                environmentId: source.environmentId,
                input: { threadId: source.threadId, reason: "user" },
              },
              { reportFailure: false },
            );
          },
        },
      }),
    );
    return "settled";
  }
  if (isAtomCommandInterrupted(result)) return "retry";
  // Settled by hand or on another tab since, or deleted: nothing is left to do.
  const shell = readThreadShell(source);
  if (shell === null) return "gone";
  if (shell.settledOverride === "settled") return "settled";
  if (!reportedFailures.has(scopedThreadKey(pending.source))) {
    reportedFailures.add(scopedThreadKey(pending.source));
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not settle “${pending.title}” on ${pending.sourceLabel}`,
        description: `${error instanceof Error ? error.message : "An error occurred."} It will be tried again.`,
      }),
    );
  }
  return "retry";
}
