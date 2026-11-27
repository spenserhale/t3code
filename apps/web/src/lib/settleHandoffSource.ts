import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentResourceNotFoundError, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, waitForThreadShell } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { threadEnvironment } from "../state/threads";
import type { PendingMachineHandoff } from "../threadMachineHandoffStore";
import type { HandoffSettleOutcome } from "./threadMachineHandoffSettle";

/** The failures already shown, so a retry that fails again does not toast again. */
const reportedFailures = new Set<string>();

const isResourceNotFound = Schema.is(EnvironmentResourceNotFoundError);

/**
 * Whether the server says the thread does not exist. A shell the client lacks proves nothing: it
 * trails a reconnect. The transcript route is the one read that answers for a thread by id.
 */
async function serverSaysGone(source: ScopedThreadRef): Promise<boolean> {
  const result = await runAtomCommand(
    appAtomRegistry,
    orchestrationEnvironment.threadTranscript,
    { environmentId: source.environmentId, input: { threadId: source.threadId } },
    { reportFailure: false },
  );
  return result._tag === "Failure" && isResourceNotFound(squashAtomCommandFailure(result));
}

/**
 * Settles the thread a machine handoff came from, and offers to take that back. A failure leaves
 * the handoff to be tried again: the source may be busy, away, or about to be granted access.
 */
export async function settleHandoffSource(
  pending: PendingMachineHandoff,
): Promise<HandoffSettleOutcome> {
  const { source } = pending;
  if (readThreadShell(source) === null && !(await waitForThreadShell(source))) {
    return (await serverSaysGone(source)) ? "gone" : "retry";
  }
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
  if (shell === null) return (await serverSaysGone(source)) ? "gone" : "retry";
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
