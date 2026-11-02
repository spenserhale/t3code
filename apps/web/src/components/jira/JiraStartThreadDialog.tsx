import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, JiraIssueDetail } from "@t3tools/contracts";
import { useId, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useEnvironments } from "~/state/environments";
import { readThreadShells, useProjects } from "~/state/entities";
import { jiraReadTransitions, jiraTransition } from "~/state/jira";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { issueBranchName, issueThreadTitle, unusedBranchName } from "./jiraIssueKeys";
import { transitionToStatus, useJiraPreferences } from "./jiraPreferences";
import { registerJiraThreadStart } from "./jiraThreadStarts";
import { issueThreadPrompt } from "./jiraThreadText";

export function JiraStartThreadDialog({
  open,
  onOpenChange,
  issue,
  jiraEnvironmentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issue: JiraIssueDetail;
  jiraEnvironmentId: EnvironmentId;
}) {
  const id = useId();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const newThread = useNewThreadHandler();
  const [preferences, updatePreferences] = useJiraPreferences();
  const readTransitions = useAtomCommand(jiraReadTransitions, { reportFailure: false });
  const transition = useAtomCommand(jiraTransition, { reportFailure: false });
  const [choice, setChoice] = useState<string | null>(null);
  const [worktreeChoice, setWorktreeChoice] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  const available = projects.filter((project) => project.archivedAt == null);
  const remembered = preferences.projects[issue.projectKey];
  const projectKey = (project: { readonly environmentId: string; readonly id: string }) =>
    `${project.environmentId}:${project.id}`;
  const selected =
    available.find((project) => projectKey(project) === choice) ??
    available.find(
      (project) =>
        remembered !== undefined &&
        project.environmentId === remembered.environmentId &&
        project.id === remembered.projectId,
    ) ??
    available.find((project) => project.title.toLowerCase() === issue.projectName.toLowerCase()) ??
    available[0];
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const showEnvironment = new Set(available.map((project) => project.environmentId)).size > 1;
  const projectLabel = (project: { environmentId: EnvironmentId; title: string }) =>
    showEnvironment
      ? `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
      : project.title;

  const newWorktree = worktreeChoice ?? preferences.newWorktree;
  const branch = unusedBranchName(
    issueBranchName(issue.key, issue.summary),
    new Set(readThreadShells().flatMap((shell) => (shell.branch === null ? [] : [shell.branch]))),
  );

  const start = async () => {
    if (selected === undefined || pending) return;
    setPending(true);
    const prompt = issueThreadPrompt(issue);
    const opened = await newThread(scopeProjectRef(selected.environmentId, selected.id), {
      envMode: newWorktree ? "worktree" : "local",
      prompt,
    }).then(
      (session) => session,
      () => null,
    );
    setPending(false);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    // A draft the person had already written in keeps its text, so the issue goes after it.
    const drafted = useComposerDraftStore.getState().getComposerDraft(opened.draftId)?.prompt ?? "";
    if (!drafted.includes(issue.url)) {
      useComposerDraftStore
        .getState()
        .setPrompt(
          opened.draftId,
          drafted.trim() === "" ? prompt : `${drafted.trimEnd()}\n\n${prompt}`,
        );
    }
    registerJiraThreadStart({
      environmentId: selected.environmentId,
      threadId: opened.threadId,
      issueKey: issue.key,
      title: issueThreadTitle(issue.key, issue.summary),
      branch: newWorktree ? branch : null,
    });
    updatePreferences({
      newWorktree,
      projects: {
        ...preferences.projects,
        [issue.projectKey]: { environmentId: selected.environmentId, projectId: selected.id },
      },
    });
    onOpenChange(false);
    toastManager.add({
      type: "success",
      title: `Started a thread for ${issue.key}`,
      description: "The issue is in the composer. Read it over, then send.",
    });
    const moveTo = preferences.moveOnStart;
    if (moveTo === null || issue.status.name.toLowerCase() === moveTo.trim().toLowerCase()) return;
    const listed = await readTransitions({
      environmentId: jiraEnvironmentId,
      input: { key: issue.key },
    });
    const move =
      listed._tag === "Success" ? transitionToStatus(listed.value.transitions, moveTo) : null;
    if (move === null) {
      toastManager.add({
        type: "warning",
        title: `${issue.key} was not moved`,
        description:
          listed._tag === "Failure"
            ? "Jira did not list its moves."
            : `Jira offers no move to ${moveTo} from ${issue.status.name}.`,
      });
      return;
    }
    const moved = await transition({
      environmentId: jiraEnvironmentId,
      input: { key: issue.key, transitionId: move.id },
    });
    if (moved._tag === "Failure") {
      const error = squashAtomCommandFailure(moved);
      toastManager.add({
        type: "warning",
        title: `${issue.key} was not moved`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    toastManager.add({ type: "success", title: `Moved ${issue.key} to ${move.to.name}` });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Start a thread for {issue.key}</DialogTitle>
          <DialogDescription>
            The key, summary, description and link go into the composer for you to read over before
            anything is sent.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-project`}>Project</Label>
              {available.length === 0 ? (
                <p className="text-muted-foreground text-sm">Add a project first.</p>
              ) : (
                <Select
                  value={selected === undefined ? null : projectKey(selected)}
                  onValueChange={(value) => setChoice(value)}
                >
                  <SelectTrigger id={`${id}-project`} aria-label="Project">
                    <SelectValue>
                      {(value: string | null) => {
                        const project = available.find((entry) => projectKey(entry) === value);
                        return project === undefined ? "" : projectLabel(project);
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {available.map((project) => (
                      <SelectItem
                        key={projectKey(project)}
                        hideIndicator
                        value={projectKey(project)}
                      >
                        {projectLabel(project)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </div>
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Label htmlFor={`${id}-worktree`}>New worktree</Label>
                <p className="text-muted-foreground text-xs">
                  Works on its own branch, <span className="font-mono">{branch}</span>, apart from
                  the project's checkout.
                </p>
              </div>
              <Switch
                id={`${id}-worktree`}
                checked={newWorktree}
                onCheckedChange={setWorktreeChoice}
                aria-label="New worktree"
              />
            </div>
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
          <Button
            type="button"
            size="sm"
            onClick={() => void start()}
            disabled={pending || selected === undefined}
          >
            {pending ? "Starting..." : "Start thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
