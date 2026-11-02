import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { useProjects, useThreadShells } from "~/state/entities";
import { jiraConfiguredEnvironmentIdsAtom } from "~/state/jira";
import { useEnvironmentsWithScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { threadUsesJiraSite } from "./jiraEnvironments";
import { linkedThreadTitle } from "./jiraIssueKeys";

const MAX_SHOWN = 40;

/**
 * Links a thread to an issue by putting the key at the front of its title. Only threads that can
 * be changed, and whose key would be read on this issue's Jira site, are offered.
 */
export function JiraLinkThreadDialog({
  open,
  onOpenChange,
  issueKey,
  jiraEnvironmentId,
  linked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issueKey: string;
  jiraEnvironmentId: EnvironmentId;
  linked: ReadonlyArray<ScopedThreadRef>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const shells = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const configured = useAtomValue(jiraConfiguredEnvironmentIdsAtom);
  const changeable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const [openSeen, setOpenSeen] = useState(open);
  if (openSeen !== open) {
    setOpenSeen(open);
    if (open) {
      setQuery("");
      setSelected(null);
    }
  }

  const needle = query.trim().toLowerCase();
  const alreadyLinked = new Set(linked.map((ref) => `${ref.environmentId}:${ref.threadId}`));
  const candidates = shells
    .filter(
      (shell) =>
        shell.archivedAt === null &&
        shell.deletedAt === null &&
        changeable.has(shell.environmentId) &&
        threadUsesJiraSite(shell.environmentId, configured, jiraEnvironmentId) &&
        !alreadyLinked.has(`${shell.environmentId}:${shell.id}`) &&
        (needle.length === 0 ||
          shell.title.toLowerCase().includes(needle) ||
          (shell.branch ?? "").toLowerCase().includes(needle)),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_SHOWN);
  const choice = candidates.find((shell) => `${shell.environmentId}:${shell.id}` === selected);

  const link = async () => {
    if (choice === undefined || pending) return;
    setPending(true);
    const result = await updateThreadMetadata({
      environmentId: choice.environmentId,
      input: { threadId: choice.id, title: linkedThreadTitle(choice.title, issueKey) },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not link the thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    toastManager.add({ type: "success", title: `Linked to ${issueKey}` });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-xl" initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>Link a thread to {issueKey}</DialogTitle>
          <DialogDescription>
            The key goes at the front of the thread's title. Anything whose title or branch names an
            issue shows up under it.
            {configured.length > 1 ? " Only threads that use this Jira site are listed." : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search threads"
              aria-label="Search threads"
            />
            <ul className="-mx-1 flex max-h-72 flex-col overflow-y-auto">
              {candidates.map((shell) => {
                const key = `${shell.environmentId}:${shell.id}`;
                const project = projects.find(
                  (candidate) =>
                    candidate.environmentId === shell.environmentId &&
                    candidate.id === shell.projectId,
                );
                return (
                  <li key={key}>
                    <button
                      type="button"
                      aria-pressed={selected === key}
                      onClick={() => setSelected(key)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                        selected === key ? "bg-accent" : "hover:bg-accent/60",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{shell.title}</span>
                      {project === undefined ? null : (
                        <span className="max-w-32 shrink-0 truncate text-2xs text-muted-foreground">
                          {project.title}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
              {candidates.length === 0 ? (
                <li className="px-2 py-3 text-muted-foreground text-sm">No threads match.</li>
              ) : null}
            </ul>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void link()} disabled={pending || !choice}>
            {pending ? "Linking..." : "Link thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
