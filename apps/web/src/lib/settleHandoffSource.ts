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

/** Settles the thread a machine handoff came from, and offers to take that back. */
export async function settleHandoffSource(pending: PendingMachineHandoff): Promise<void> {
  const { source } = pending;
  // The shell can trail the connection; a thread that is still missing then was deleted.
  if (readThreadShell(source) === null && !(await waitForThreadShell(source))) return;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.settle,
    { environmentId: source.environmentId, input: { threadId: source.threadId } },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
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
    return;
  }
  if (isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: `Could not settle “${pending.title}” on ${pending.sourceLabel}`,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}
