import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect, useEffectEvent } from "react";

import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { JiraCommentDialogHost } from "./JiraCommentDialog";
import {
  forgetJiraThreadStart,
  nextStepForThreadStart,
  useJiraThreadStarts,
  type JiraThreadStart,
} from "./jiraThreadStarts";

function WatchedThreadStart({ start }: { start: JiraThreadStart }) {
  const shell = useThreadShell(scopeThreadRef(start.environmentId, start.threadId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const step = nextStepForThreadStart(shell, start);
  const settle = useEffectEvent(() => {
    forgetJiraThreadStart(start.threadId);
    if (step === "rename") {
      void updateThreadMetadata({
        environmentId: start.environmentId,
        input: { threadId: start.threadId, title: start.title },
      });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives a started thread its title once the one generated from its first message has settled
  useEffect(() => {
    if (step !== "wait") settle();
  }, [step]);
  return null;
}

/**
 * Mounted for the life of the app: gives threads started from an issue their
 * `KEY: summary` title, and hosts the comment dialog the thread chips open.
 */
export function JiraHost() {
  const starts = useJiraThreadStarts();
  return (
    <>
      {starts.map((start) => (
        <WatchedThreadStart key={start.threadId} start={start} />
      ))}
      <JiraCommentDialogHost />
    </>
  );
}
