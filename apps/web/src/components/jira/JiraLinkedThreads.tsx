import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { UnlinkIcon } from "lucide-react";

import { useProject, useThreadShell } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { unlinkedThreadTitle } from "./jiraIssueKeys";

function LinkedThreadRow({
  threadRef,
  issueKey,
}: {
  threadRef: ScopedThreadRef;
  issueKey: string;
}) {
  const router = useRouter();
  const shell = useThreadShell(threadRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(shell.environmentId, shell.projectId),
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const canChange = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  if (shell === null) return null;
  const withoutKey = unlinkedThreadTitle(shell.title, issueKey);

  const unlink = async () => {
    if (withoutKey === null) return;
    const result = await updateThreadMetadata({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, title: withoutKey },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not unlink the thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  return (
    <li className="flex items-center gap-1 rounded-md hover:bg-accent/60">
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() =>
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          })
        }
      >
        <span className="min-w-0 flex-1 truncate text-sm">{shell.title}</span>
        {project === null ? null : (
          <span className="max-w-32 shrink-0 truncate text-2xs text-muted-foreground">
            {project.title}
          </span>
        )}
        <span className="shrink-0 whitespace-nowrap text-2xs tabular-nums text-muted-foreground">
          <RelativeTime timestamp={shell.updatedAt} />
        </span>
      </button>
      {withoutKey === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Unlink from ${issueKey}`}
                disabled={!canChange}
                onClick={() => void unlink()}
              />
            }
          >
            <UnlinkIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {canChange ? `Take ${issueKey} off the title` : "This connection cannot change threads"}
          </TooltipPopup>
        </Tooltip>
      )}
    </li>
  );
}

export function JiraLinkedThreads({
  threadRefs,
  issueKey,
}: {
  threadRefs: ReadonlyArray<ScopedThreadRef>;
  issueKey: string;
}) {
  if (threadRefs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No thread mentions {issueKey} in its title or branch yet.
      </p>
    );
  }
  return (
    <ul className="-mx-2 flex flex-col">
      {threadRefs.map((ref) => (
        <LinkedThreadRow
          key={`${ref.environmentId}:${ref.threadId}`}
          threadRef={ref}
          issueKey={issueKey}
        />
      ))}
    </ul>
  );
}
