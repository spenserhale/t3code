import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useThreadShell } from "~/state/entities";
import {
  jiraConfiguredEnvironmentIdsAtom,
  jiraLinkedThreadsAtom,
  refreshJiraChips,
} from "~/state/jira";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { JiraCommentDialogHost } from "./JiraCommentDialog";
import {
  followUpToRename,
  forgetJiraThreadStart,
  nextStepForThreadStart,
  renameOutcome,
  useJiraThreadStarts,
  type JiraThreadStart,
} from "./jiraThreadStarts";

function WatchedThreadStart({ start }: { start: JiraThreadStart }) {
  const shell = useThreadShell(scopeThreadRef(start.environmentId, start.threadId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const step = nextStepForThreadStart(shell, start);
  const rename = useEffectEvent(() =>
    updateThreadMetadata({
      environmentId: start.environmentId,
      input: { threadId: start.threadId, title: start.title },
    }),
  );
  // The start is forgotten once the title is set, or can never be set. A failure that may pass
  // leaves it in place, and the rename is tried again.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives a started thread its title once the one generated from its first message has settled
  useEffect(() => {
    if (step === "wait") return;
    if (step === "done") {
      forgetJiraThreadStart(start.threadId);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (failures: number) => {
      const result = await rename();
      if (cancelled) return;
      const next = followUpToRename(renameOutcome(result), failures + 1);
      if (next === "forget") forgetJiraThreadStart(start.threadId);
      else if (next !== "keep")
        timer = setTimeout(() => void attempt(failures + 1), next.retryInMs);
    };
    void attempt(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step, start.threadId]);
  return null;
}

/** Keeps one site's status chips current, only while the window is in view and in use. */
function ChipRefresh({ environmentId }: { environmentId: EnvironmentId }) {
  const linked = useAtomValue(jiraLinkedThreadsAtom(environmentId));
  useLiveRefresh(() => refreshJiraChips(environmentId), {
    enabled: linked.size > 0,
    key: `jira-chips:${environmentId}`,
    intervalMs: 60_000,
  });
  return null;
}

/**
 * Mounted for the life of the app: gives threads started from an issue their
 * `KEY: summary` title, keeps the status chips current, and hosts the comment
 * dialog the thread chips open.
 */
export function JiraHost() {
  const starts = useJiraThreadStarts();
  const configured = useAtomValue(jiraConfiguredEnvironmentIdsAtom);
  return (
    <>
      {starts.map((start) => (
        <WatchedThreadStart key={start.threadId} start={start} />
      ))}
      {configured.map((environmentId) => (
        <ChipRefresh key={environmentId} environmentId={environmentId} />
      ))}
      <JiraCommentDialogHost />
    </>
  );
}
