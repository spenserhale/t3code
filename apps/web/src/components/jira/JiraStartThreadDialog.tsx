import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, JiraIssueDetail } from "@t3tools/contracts";
import { useId, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useProjects } from "~/state/entities";
import {
  jiraConfiguredEnvironmentIdsAtom,
  jiraReadTransitions,
  jiraTransition,
} from "~/state/jira";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
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
import { threadUsesJiraSite } from "./jiraEnvironments";
import { readExistingBranchNames } from "./jiraBranches";
import { issueBranchName, issueThreadTitle, unusedBranchName } from "./jiraIssueKeys";
import { transitionToStatus, useJiraPreferences } from "./jiraPreferences";
import { pendingStartBranches, registerJiraThreadStart, threadStartPlan } from "./jiraThreadStarts";
import { issueAskPrompt, issuePlanPrompt, issueThreadPrompt } from "./jiraThreadText";

/** What a thread started from an issue is for. */
export type JiraThreadMode = "work" | "ask" | "plan";

const MODES: Record<
  JiraThreadMode,
  {
    readonly title: (key: string) => string;
    readonly description: string;
    readonly prompt: (issue: JiraIssueDetail) => string;
    /** Whether the thread works in a worktree of its own, as work and plans on an issue do. */
    readonly worktree: boolean;
  }
> = {
  work: {
    title: (key) => `Work on ${key}`,
    description:
      "The key, summary, description, acceptance criteria and link go into the composer for you to read over before anything is sent.",
    prompt: issueThreadPrompt,
    worktree: true,
  },
  ask: {
    title: (key) => `Ask about ${key}`,
    description:
      "The issue goes into the composer with room for your question. The thread is asked to answer without changing any code.",
    prompt: issueAskPrompt,
    worktree: false,
  },
  plan: {
    title: (key) => `Plan ${key}`,
    description:
      "The issue goes into the composer and the thread starts in plan mode, so it writes a plan before anything is changed.",
    prompt: issuePlanPrompt,
    worktree: true,
  },
};

export function JiraStartThreadDialog({
  open,
  onOpenChange,
  issue,
  jiraEnvironmentId,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issue: JiraIssueDetail;
  jiraEnvironmentId: EnvironmentId;
  mode: JiraThreadMode;
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
  const { worktree: usesWorktree, ...copy } = MODES[mode];

  const [openSeen, setOpenSeen] = useState(open);
  if (openSeen !== open) {
    setOpenSeen(open);
    if (open) setWorktreeChoice(null);
  }

  // A thread's key is read on the Jira site of its own environment. A project on an environment
  // with a Jira of its own would show this issue's key as that site's issue, so it is not offered.
  const configured = useAtomValue(jiraConfiguredEnvironmentIdsAtom);
  const unarchived = projects.filter((project) => project.archivedAt == null);
  const available = unarchived.filter((project) =>
    threadUsesJiraSite(project.environmentId, configured, jiraEnvironmentId),
  );
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

  const repository = useEnvironmentQuery(
    open && usesWorktree && selected !== undefined
      ? vcsEnvironment.status({
          environmentId: selected.environmentId,
          input: { cwd: selected.workspaceRoot, includeRemote: false },
        })
      : null,
  );
  const isRepository = repository.data === null ? null : repository.data.isRepo;
  const detectionFailed = repository.error !== null;
  const plan = usesWorktree
    ? threadStartPlan({ isRepository, detectionFailed, choice: worktreeChoice })
    : ({ ready: true, worktree: false } as const);
  const branchBase = issueBranchName(issue.key, issue.summary);

  /** A branch name no branch of the repository, thread or unsent start has, read when asked for. */
  const freeBranch = async (project: {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }) =>
    unusedBranchName(
      branchBase,
      new Set([...(await readExistingBranchNames(project, branchBase)), ...pendingStartBranches()]),
    );

  const readsThisSite = (project: { readonly environmentId: EnvironmentId }) =>
    threadUsesJiraSite(
      project.environmentId,
      appAtomRegistry.get(jiraConfiguredEnvironmentIdsAtom),
      jiraEnvironmentId,
    );

  const start = async () => {
    if (selected === undefined || pending || !plan.ready) return;
    if (!readsThisSite(selected)) {
      toastManager.add({
        type: "error",
        title: `${issue.key} cannot go to ${selected.title}`,
        description: "Jira was set up or removed since the list was drawn. Pick the project again.",
      });
      return;
    }
    setPending(true);
    const branch = plan.worktree ? await freeBranch(selected) : null;
    const prompt = copy.prompt(issue);
    const opened = await newThread(scopeProjectRef(selected.environmentId, selected.id), {
      envMode: plan.worktree ? "worktree" : "local",
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
    if (mode === "plan") {
      useComposerDraftStore
        .getState()
        .setDraftThreadContext(opened.draftId, { interactionMode: "plan" });
    }
    // Jira can change while the thread opens; a link made now could name another site's issue.
    if (!readsThisSite(selected)) {
      onOpenChange(false);
      toastManager.add({
        type: "warning",
        title: `The thread was not linked to ${issue.key}`,
        description: `Jira changed while it opened, so ${issue.key} would be read on another site.`,
      });
      return;
    }
    registerJiraThreadStart({
      environmentId: selected.environmentId,
      threadId: opened.threadId,
      issueKey: issue.key,
      title: issueThreadTitle(issue.key, issue.summary),
      branch,
    });
    updatePreferences({
      projects: {
        ...preferences.projects,
        [issue.projectKey]: { environmentId: selected.environmentId, projectId: selected.id },
      },
    });
    onOpenChange(false);
    toastManager.add({
      type: "success",
      title: `Started a thread for ${issue.key}`,
      description:
        branch !== null && branch !== branchBase
          ? `The issue is in the composer. Read it over, then send. ${branchBase} was taken, so it works on ${branch}.`
          : "The issue is in the composer. Read it over, then send.",
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
          <DialogTitle>{copy.title(issue.key)}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-project`}>Project</Label>
              {available.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {unarchived.length === 0
                    ? "Add a project first."
                    : `Other projects are on environments with a Jira of their own, which would read ${issue.key} as another site's issue. Add a project on ${environmentLabels.get(jiraEnvironmentId) ?? "the environment with this Jira"}.`}
                </p>
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
            {usesWorktree ? (
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Label htmlFor={`${id}-worktree`}>New worktree</Label>
                  <p className="text-muted-foreground text-xs">
                    {isRepository === true ? (
                      <>
                        Works on its own branch named from the issue, like{" "}
                        <span className="font-mono">{branchBase}</span>, which keeps the thread
                        linked to the issue.
                      </>
                    ) : isRepository === false ? (
                      "This project is not a Git repository, so it has no worktrees. The thread is linked through its title."
                    ) : detectionFailed ? (
                      "Could not tell whether this project is a Git repository. Turn this off to start without a worktree."
                    ) : (
                      "Checking the project..."
                    )}
                  </p>
                </div>
                <Switch
                  id={`${id}-worktree`}
                  checked={plan.ready ? plan.worktree : (worktreeChoice ?? true)}
                  disabled={isRepository === false || (isRepository === null && !detectionFailed)}
                  onCheckedChange={setWorktreeChoice}
                  aria-label="New worktree"
                />
              </div>
            ) : null}
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
            disabled={pending || selected === undefined || !plan.ready}
          >
            {pending ? "Starting..." : "Start thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
