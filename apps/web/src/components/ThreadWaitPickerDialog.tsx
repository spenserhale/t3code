import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { primaryServerKeybindingsAtom } from "../state/server";
import { useProjects, useThreadShells } from "../state/entities";
import { threadWaitEnvironment } from "../state/threadWaits";
import { CommandPaletteContent } from "./CommandPaletteContent";
import type { CommandPaletteActionItem } from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ProjectFavicon } from "./ProjectFavicon";
import { listThreadWaitBlockerCandidates } from "./threadWait.logic";
import { finishThreadWaitPicker, useThreadWaitPickerRequest } from "./threadWaitPicker.state";
import { CommandDialog, CommandDialogPopup } from "./ui/command";

const PICKER_LIMIT = 50;

export function ThreadWaitPickerHost() {
  const request = useThreadWaitPickerRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves a pending picker request with null when the host unmounts
  useEffect(() => () => finishThreadWaitPicker(null), []);
  return request ? <ThreadWaitPickerDialog threadRef={request.threadRef} /> : null;
}

function ThreadWaitPickerDialog(props: { threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const threads = useThreadShells();
  const projects = useProjects();
  const index = useAtomValue(threadWaitEnvironment.index(threadRef.environmentId));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const projectById = new Map(
    projects
      .filter((project) => project.environmentId === threadRef.environmentId)
      .map((project) => [project.id, project] as const),
  );
  const items: CommandPaletteActionItem[] = listThreadWaitBlockerCandidates({
    threads,
    waiting: { environmentId: threadRef.environmentId, id: threadRef.threadId },
    waits: index.waits,
    query,
    projectTitle: (thread) => projectById.get(thread.projectId)?.title ?? null,
  })
    .slice(0, PICKER_LIMIT)
    .map((thread) => {
      const project = projectById.get(thread.projectId);
      return {
        kind: "action",
        value: `thread-wait:${thread.id}`,
        searchTerms: [thread.title],
        title: thread.title.trim() || "Untitled thread",
        ...(project ? { description: project.title } : {}),
        icon: project ? (
          <ProjectFavicon project={project} className="size-4" />
        ) : (
          <MessageSquareIcon className="size-4 text-secondary-label" />
        ),
        run: async () => finishThreadWaitPicker(thread.id),
      };
    });
  const close = () => finishThreadWaitPicker(null);

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <CommandDialogPopup
        aria-label="Snooze until a thread is done"
        className="overflow-hidden"
        onBackdropPointerDown={close}
      >
        <CommandPaletteContent
          aria-label="Snooze until a thread is done"
          autoHighlight="always"
          escapeLabel="Close"
          footerActionLabel="Snooze until done"
          inputProps={{ placeholder: "Snooze until this thread is done…" }}
          mode="none"
          onItemHighlighted={(value) => {
            setHighlightedItemValue(typeof value === "string" ? value : null);
          }}
          onValueChange={(value) => {
            setHighlightedItemValue(null);
            setQuery(value);
          }}
          testId="thread-wait-picker"
          value={query}
        >
          <CommandPaletteResults
            groups={items.length > 0 ? [{ value: "thread-wait", label: "Threads", items }] : []}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind === "action") void item.run();
            }}
            emptyStateMessage={
              query.trim() ? "No matching threads." : "No open threads to wait on."
            }
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
