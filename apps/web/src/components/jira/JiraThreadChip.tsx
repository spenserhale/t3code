import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, JiraStatusCategory, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { TicketIcon } from "lucide-react";
import type { ReactElement } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import type { ThreadJiraLink } from "~/state/jira";
import { cn } from "~/lib/utils";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { openJiraCommentDialog } from "./JiraCommentDialog";
import { readJiraView } from "./jiraViewMemory";

const STATUS_DOT: Record<JiraStatusCategory, string> = {
  todo: "bg-muted-foreground/60",
  "in-progress": "bg-info",
  done: "bg-success",
  unknown: "bg-muted-foreground/40",
};

/** The issue a thread is about and where it stands, with what a person does next. */
export function JiraThreadChip({
  link,
  thread,
  render = <InlineButton tone="muted" />,
  panel = false,
}: {
  link: ThreadJiraLink | null;
  thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  } | null;
  /** The control the chip is drawn as; sidebar rows use the inline one. */
  render?: ReactElement;
  /** Drawn as a row of the thread details panel, which gives its icon and labels their own style. */
  panel?: boolean;
}) {
  const navigate = useNavigate();
  if (link === null || thread === null) return null;
  const status = link.issue?.status ?? null;
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Jira issue ${link.key}${status === null ? "" : `, ${status.name}`}`}
        onClick={stop}
        render={render}
      >
        <TicketIcon
          aria-hidden
          className={panel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
        />
        <span className={cn("shrink-0", panel && THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {link.key}
        </span>
        {status === null ? null : (
          <>
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status.category])}
            />
            <span
              className={cn(
                "truncate",
                panel
                  ? cn("min-w-0 text-muted-foreground", THREAD_DETAILS_PANEL_LABEL_CLASS)
                  : "max-w-24",
              )}
            >
              {status.name}
            </span>
          </>
        )}
      </MenuTrigger>
      <MenuPopup align={panel ? "start" : "end"} onClick={stop}>
        <MenuItem
          onClick={() =>
            void navigate({
              to: "/jira",
              search: { ...readJiraView(), issue: link.key, environmentId: link.environmentId },
            })
          }
        >
          Open issue
        </MenuItem>
        <MenuItem
          onClick={() =>
            openJiraCommentDialog({
              environmentId: link.environmentId,
              issueKey: link.key,
              threadRef: scopeThreadRef(thread.environmentId, thread.id),
            })
          }
        >
          Add comment...
        </MenuItem>
        {link.issue === null ? null : (
          <MenuItem render={<a href={link.issue.url} target="_blank" rel="noreferrer noopener" />}>
            Open in Jira
          </MenuItem>
        )}
        <MenuItem
          onClick={() =>
            void writeTextToClipboard(link.key, "issue key").then((copied) => {
              if (copied) toastManager.add({ type: "success", title: "Issue key copied" });
            })
          }
        >
          Copy key
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
