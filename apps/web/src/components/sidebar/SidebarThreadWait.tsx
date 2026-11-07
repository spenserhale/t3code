import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Link2Icon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";

import { pickThreadAndWait } from "../../lib/threadWaitActions";
import { cn } from "../../lib/utils";
import { readThreadShell, useThreadShell } from "../../state/entities";
import { threadWaitBlockingCountAtom, threadWaitEnvironment } from "../../state/threadWaits";
import { useThreadWaitDragBadge } from "../Sidebar.waitDrag";
import { threadWaitBlocksLabel, threadWaitLabel } from "../threadWait.logic";
import { MenuItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const stop = (event: ReactMouseEvent) => event.stopPropagation();

/** "Waiting on <title>" on a snoozed row; opens the blocker when it is known here. */
export function SidebarThreadWaitLabel(props: {
  environmentId: EnvironmentId;
  blockerThreadId: ThreadId;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { environmentId, blockerThreadId, onOpen } = props;
  const blocker = useThreadShell(scopeThreadRef(environmentId, blockerThreadId));
  const label = threadWaitLabel(blocker?.title);
  const className =
    "inline-flex min-w-0 max-w-[55%] shrink items-center gap-1 text-xs text-info-foreground";
  if (blocker === null) {
    return (
      <span className={className}>
        <Link2Icon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(scopeThreadRef(environmentId, blockerThreadId));
      }}
      onDoubleClick={stop}
      className={cn(
        className,
        "cursor-pointer rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
    >
      <Link2Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function BlockedThreadTitles(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const index = useAtomValue(threadWaitEnvironment.index(props.environmentId));
  const blocked = index.waits.filter((wait) => wait.blockerThreadId === props.threadId);
  return (
    <div className="flex max-w-64 flex-col">
      <span className="text-muted-foreground">Waiting on this thread</span>
      {blocked.map((wait) => (
        <span key={wait.threadId} className="truncate">
          {readThreadShell(scopeThreadRef(props.environmentId, wait.threadId))?.title.trim() ||
            "A thread"}
        </span>
      ))}
    </div>
  );
}

/** "blocks N" on a thread other threads wait on. */
export function SidebarThreadBlocksMarker(props: {
  threadKey: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const count = useAtomValue(threadWaitBlockingCountAtom(props.threadKey));
  if (count === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-info-foreground" />
        }
      >
        <Link2Icon aria-hidden className="size-3" />
        {threadWaitBlocksLabel(count)}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <BlockedThreadTitles environmentId={props.environmentId} threadId={props.threadId} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** "Until thread…" in the row's snooze menu, for servers that can link threads. */
export function ThreadWaitSnoozeMenuItem(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const supported = useAtomValue(threadWaitEnvironment.supported(props.environmentId));
  if (!supported) return null;
  return (
    <MenuItem
      onClick={(event) => {
        event.stopPropagation();
        void pickThreadAndWait(scopeThreadRef(props.environmentId, props.threadId));
      }}
    >
      Until thread…
    </MenuItem>
  );
}

export function ThreadWaitDragBadge() {
  const badge = useThreadWaitDragBadge();
  if (badge === null) return null;
  return createPortal(
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed left-0 top-0 z-[100] flex max-w-72 items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg",
        !badge.valid && "text-muted-foreground",
      )}
      style={{ transform: `translate(${badge.x + 12}px, ${badge.y + 12}px)` }}
    >
      <Link2Icon className="size-4 shrink-0 text-info-foreground" />
      <span className="truncate">{badge.label}</span>
    </div>,
    document.body,
  );
}
