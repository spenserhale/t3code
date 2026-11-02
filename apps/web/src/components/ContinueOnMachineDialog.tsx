import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  assessHandoffMachines,
  carriesHandoffCode,
  collectHandoffBranchNames,
  explainNoHandoffCode,
  HANDOFF_BRANCH_QUERY,
  isHandoffDefaultBranch,
  listHandoffSteps,
  planThreadMachineHandoff,
  type HandoffGitStatus,
  type HandoffMachine,
  type HandoffReady,
  type HandoffStep,
} from "@t3tools/client-runtime/thread-machine-handoff";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { CheckIcon, CircleAlertIcon, CircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import {
  continueOnChoiceOf,
  useHandoffEnvironments,
  useHandoffSourceAccess,
} from "../lib/handoffMachines";
import { readAllRefPages } from "../lib/handoffRefs";
import {
  runThreadMachineHandoff,
  type HandoffStepState,
  type ThreadMachineHandoffResult,
} from "../lib/threadMachineHandoff";
import { createThreadMachineHandoffIo } from "../lib/threadMachineHandoffIo";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentMachines } from "../state/environments";
import { readThreadShell, useProjects, useQuietThreadShell } from "../state/entities";
import { vcsEnvironment } from "../state/vcs";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import {
  closeContinueOnMachine,
  type ContinueOnMachineRequest,
  useContinueOnMachineRequest,
} from "./continueOnMachineState";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";

export function ContinueOnMachineDialogHost() {
  const request = useContinueOnMachineRequest((state) => state.request);
  const session = useContinueOnMachineRequest((state) => state.session);
  return request ? <ContinueOnMachineDialog key={session} request={request} /> : null;
}

type GitLoad =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly status: VcsStatusResult;
      /** Whether the repository names its default branch, so any other can be told from it. */
      readonly defaultBranchKnown: boolean;
      /** The branch names a new handoff branch has to avoid; only read when it will be made. */
      readonly branchNames: ReadonlyArray<string>;
    }
  | { readonly kind: "failed"; readonly message: string };

function failureText(result: AtomCommandResult<unknown, unknown>, fallback: string): string {
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * Reads now, bypassing caches: the plan commits and pushes whatever is there. A read that fails
 * fails the whole load; a plan made from part of the answers could push to the default branch or
 * pick a name that is taken.
 */
async function readGit(environmentId: EnvironmentId, cwd: string): Promise<GitLoad> {
  const readRefs = (input: {
    readonly query?: string;
    readonly cursor?: number;
    readonly limit: number;
  }) =>
    runAtomCommand(
      appAtomRegistry,
      vcsEnvironment.readRefs,
      {
        environmentId,
        input: {
          cwd,
          includeMatchingRemoteRefs: true,
          limit: input.limit,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        },
      },
      { reportFailure: false },
    );
  const refreshed = await runAtomCommand(
    appAtomRegistry,
    vcsEnvironment.refreshStatus,
    { environmentId, input: { cwd } },
    { reportFailure: false },
  );
  if (refreshed._tag !== "Success") {
    return {
      kind: "failed",
      message: failureText(refreshed, "Could not read the repository's status."),
    };
  }
  const status = refreshed.value;
  // The server lists the current branch first and the default second, so a few refs show whether
  // the repository names one.
  const leading = await readRefs({ limit: 5 });
  if (leading._tag !== "Success") {
    return {
      kind: "failed",
      message: failureText(leading, "Could not read the repository's branches."),
    };
  }
  const defaultBranchKnown = leading.value.refs.some((ref) => ref.isDefault);
  if (!isHandoffDefaultBranch({ ...status, defaultBranchKnown })) {
    return { kind: "ready", status, defaultBranchKnown, branchNames: [] };
  }
  try {
    const refs = await readAllRefPages(async (cursor) => {
      const page = await readRefs({
        query: HANDOFF_BRANCH_QUERY,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page._tag !== "Success") {
        throw new Error(failureText(page, "Could not read the repository's branches."));
      }
      return page.value;
    });
    return {
      kind: "ready",
      status,
      defaultBranchKnown,
      branchNames: collectHandoffBranchNames(refs),
    };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "Could not read the repository's branches.",
    };
  }
}

function handoffGitOf(git: GitLoad): HandoffGitStatus | null {
  return git.kind === "ready"
    ? { ...git.status, defaultBranchKnown: git.defaultBranchKnown }
    : null;
}

function filesText(count: number) {
  return `${count} changed ${count === 1 ? "file" : "files"}`;
}

/** What the WIP commit will push, so a file that should not leave the machine is seen first. */
function summarizePaths(paths: ReadonlyArray<string>): string {
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

function stepLabel(step: HandoffStep, plan: HandoffReady, projectTitle: string | null): string {
  const { code, target } = plan;
  switch (step) {
    case "conversation":
      return "Attach this conversation to the new draft";
    case "branch":
      return `Create the branch ${code.kind === "carry" ? code.branch : ""} here and switch to it`;
    case "commit":
      return code.kind === "carry" && code.commit !== null
        ? `Commit ${filesText(code.commit.fileCount)} as “${code.commit.message}”`
        : "Commit";
    case "push":
      return `Push ${code.kind === "carry" ? code.branch : "the branch"} to the remote`;
    case "fetch":
      return `Check that ${target.label} can see ${code.kind === "carry" ? code.branch : "the branch"}`;
    case "worktree":
      return `Put ${code.kind === "carry" ? code.branch : "the branch"} on a worktree on ${target.label} and check it has the pushed commit`;
    case "draft":
      return target.project === null
        ? `Open a thread without a project on ${target.label}`
        : `Open a draft on ${target.label}${projectTitle === null ? "" : ` in ${projectTitle}`}${
            code.kind === "carry" ? ", in that worktree" : ""
          }`;
  }
}

function StepIcon({ state, failed }: { state: HandoffStepState | undefined; failed: boolean }) {
  if (failed) {
    return (
      <CircleAlertIcon
        aria-label="Failed"
        className="mt-0.5 size-3.5 text-destructive-foreground"
      />
    );
  }
  if (state === "done")
    return <CheckIcon aria-label="Done" className="mt-0.5 size-3.5 text-success" />;
  if (state === "running") return <Spinner size="sm" tone="muted" className="mt-0.5" />;
  return <CircleIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground/50" />;
}

/** Where a project sits on its machine, to tell several checkouts of one repository apart. */
function projectOptionLabel(project: { readonly title: string; readonly workspaceRoot: string }) {
  return `${project.title} (${project.workspaceRoot})`;
}

function ContinueOnMachineDialog({ request }: { request: ContinueOnMachineRequest }) {
  const { threadRef } = request;
  const thread = useQuietThreadShell(threadRef);
  const projects = useProjects();
  const source =
    thread === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
        ) ?? null);
  const environments = useHandoffEnvironments();
  const sourceAccess = useHandoffSourceAccess(threadRef.environmentId);
  const machineKinds = useEnvironmentMachines();
  const newThread = useNewThreadHandler();
  const { openScratchProject } = useScratchProject();

  const sourceLabel =
    environments.find((environment) => environment.environmentId === threadRef.environmentId)
      ?.label ?? "the other machine";
  const machines = source === null ? [] : assessHandoffMachines({ source, projects, environments });
  const [chosenId, setChosenId] = useState(request.targetEnvironmentId);
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const assessed =
    machines.find((candidate) => candidate.environment.environmentId === chosenId) ??
    machines.find((candidate) => candidate.status.kind === "ready") ??
    machines[0] ??
    null;
  // Several checkouts fit: the one picked here is the one the thread continues in.
  const machine: HandoffMachine | null =
    assessed?.status.kind === "choose"
      ? (() => {
          const picked = assessed.status.projects.find((project) => project.id === chosenProjectId);
          return picked === undefined
            ? assessed
            : { environment: assessed.environment, status: { kind: "ready", project: picked } };
        })()
      : assessed;

  const cwd =
    thread === null || source === null ? null : (thread.worktreePath ?? source.workspaceRoot);
  const readsGit = source !== null && cwd !== null && carriesHandoffCode(source);
  const [git, setGit] = useState<GitLoad>({ kind: "loading" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the checkout's full status once from its machine; the live stream omits upstream counts until its remote half arrives
  useEffect(() => {
    if (!readsGit || cwd === null) return;
    let stale = false;
    void readGit(threadRef.environmentId, cwd).then((next) => {
      if (!stale) setGit(next);
    });
    return () => {
      stale = true;
    };
  }, [readsGit, cwd, threadRef.environmentId]);
  const gitStatus = git.kind === "ready" ? git.status : null;

  const planFor = (
    shell: NonNullable<typeof thread>,
    from: NonNullable<typeof source>,
    on: HandoffMachine,
    read: GitLoad,
  ) =>
    planThreadMachineHandoff({
      thread: {
        title: shell.title,
        modelSelection: shell.modelSelection,
        runStatus: shell.runtime?.status ?? null,
        hasPendingApproval: shell.hasPendingApprovals,
      },
      source: from,
      sourceAccess,
      machine: on,
      git: handoffGitOf(read),
      existingBranchNames: read.kind === "ready" ? read.branchNames : [],
    });
  const plan =
    thread === null || source === null || machine === null
      ? null
      : planFor(thread, source, machine, git);

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Partial<Record<HandoffStep, HandoffStepState>>>({});
  const [failure, setFailure] = useState<Extract<ThreadMachineHandoffResult, { ok: false }> | null>(
    null,
  );

  const submit = async () => {
    if (
      plan?.kind !== "ready" ||
      thread === null ||
      source === null ||
      machine === null ||
      cwd === null ||
      running
    ) {
      return;
    }
    setRunning(true);
    setFailure(null);
    setSteps({});
    const result = await runThreadMachineHandoff({
      plan,
      title: thread.title,
      sourceLabel,
      threadLink: formatThreadLink({
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
      }),
      io: createThreadMachineHandoffIo({
        plan,
        thread,
        cwd,
        sourceLabel,
        newThread,
        openScratchProject: (environmentId) => openScratchProject(environmentId),
        // Read again at the moment of the change: the checkout may have moved since it was read.
        replan: async () => {
          const shell = readThreadShell(threadRef);
          if (shell === null) throw new Error("This thread is no longer available.");
          const fresh = readsGit ? await readGit(threadRef.environmentId, cwd) : git;
          if (fresh.kind === "failed") throw new Error(fresh.message);
          setGit(fresh);
          return planFor(shell, source, machine, fresh);
        },
      }),
      onStep: (step, state) => setSteps((current) => ({ ...current, [step]: state })),
    });
    if (result.ok) {
      closeContinueOnMachine();
      return;
    }
    setFailure(result);
    setRunning(false);
    if (readsGit) {
      // A failed attempt may have created the branch or the commit, so plan again from a fresh read.
      setGit({ kind: "loading" });
      void readGit(threadRef.environmentId, cwd).then(setGit);
    }
  };

  const needsProject = machine?.status.kind === "needs-project" && machine.status.canAdd;
  const planSteps = plan?.kind === "ready" ? listHandoffSteps(plan) : [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) closeContinueOnMachine();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Continue on another machine</DialogTitle>
            <DialogDescription>
              <span className="line-clamp-2 break-words">
                {thread?.title ?? "This thread is not available."}
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {machines.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Connect another machine to continue this thread there.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <Select
                  value={machine?.environment.environmentId ?? null}
                  onValueChange={(value) => {
                    if (value) setChosenId(value);
                  }}
                  items={machines.map((candidate) => ({
                    value: candidate.environment.environmentId,
                    label: continueOnChoiceOf(candidate).label,
                  }))}
                  disabled={running}
                >
                  <SelectTrigger size="sm" aria-label="Machine to continue on">
                    {machine ? (
                      <EnvironmentMachineIcon
                        kind={machineKinds.get(machine.environment.environmentId) ?? "server"}
                        className="size-3.5"
                      />
                    ) : null}
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {machines.map((candidate) => {
                      const choice = continueOnChoiceOf(candidate);
                      return (
                        <SelectItem
                          key={choice.environmentId}
                          value={choice.environmentId}
                          disabled={choice.disabled}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <EnvironmentMachineIcon
                              kind={machineKinds.get(choice.environmentId) ?? "server"}
                              className="size-3"
                            />
                            {choice.label}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>

                {assessed?.status.kind === "choose" ? (
                  <Select
                    value={chosenProjectId}
                    onValueChange={(value) => setChosenProjectId(value)}
                    items={assessed.status.projects.map((project) => ({
                      value: project.id,
                      label: projectOptionLabel(project),
                    }))}
                    disabled={running}
                  >
                    <SelectTrigger size="sm" aria-label="Project to continue in">
                      <SelectValue placeholder="Choose a project" />
                    </SelectTrigger>
                    <SelectPopup>
                      {assessed.status.projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {projectOptionLabel(project)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}

                {plan?.kind === "blocked" ? (
                  <p className="text-muted-foreground text-sm">
                    {plan.reason === "git-loading" && git.kind === "failed"
                      ? git.message
                      : plan.message}
                  </p>
                ) : plan?.kind === "ready" ? (
                  <div className="flex flex-col gap-3">
                    <ul className="flex flex-col gap-1.5">
                      {planSteps.map((step) => (
                        <li key={step} className="flex items-start gap-2 text-sm">
                          <StepIcon
                            state={steps[step]}
                            failed={failure !== null && failure.step === step}
                          />
                          <span>
                            {stepLabel(
                              step,
                              plan,
                              machine?.status.kind === "ready"
                                ? (machine.status.project?.title ?? null)
                                : null,
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {plan.code.kind === "carry" &&
                    plan.code.commit !== null &&
                    gitStatus !== null ? (
                      <p className="break-words font-mono text-muted-foreground text-xs">
                        {summarizePaths(gitStatus.workingTree.files.map((file) => file.path))}
                      </p>
                    ) : null}
                    {plan.code.kind === "none" ? (
                      <p className="text-muted-foreground text-xs">
                        No code travels: {explainNoHandoffCode(plan.code.reason)}.
                      </p>
                    ) : null}
                    {!plan.transcript.attach ? (
                      <p className="text-muted-foreground text-xs">
                        {plan.target.label} takes no file attachments, so only a note about this
                        thread comes along.
                      </p>
                    ) : null}
                    <p className="text-muted-foreground text-xs">
                      {plan.modelSelection === null
                        ? `The draft uses ${plan.target.label}'s default model; this thread's is not available there.`
                        : "The draft uses this thread's model."}{" "}
                      This thread is settled when you send the first message there.
                    </p>
                  </div>
                ) : null}

                {failure !== null ? (
                  <div className="flex flex-col gap-1 text-destructive-foreground text-sm">
                    <p>{failure.message}</p>
                    {failure.leftLocalCommit ? (
                      <p>
                        The changes are committed in this checkout but were not pushed. Nothing was
                        sent to {plan?.kind === "ready" ? plan.target.label : "the other machine"}.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeContinueOnMachine}
              disabled={running}
            >
              Cancel
            </Button>
            {needsProject && machine !== null && source !== null ? (
              <Button
                type="button"
                onClick={() => {
                  closeContinueOnMachine();
                  openAddProjectToMachine({
                    projectRef: scopeProjectRef(source.environmentId, source.id),
                    targetEnvironmentId: machine.environment.environmentId,
                  });
                }}
              >
                Add project to {machine.environment.label}…
              </Button>
            ) : (
              <Button type="submit" disabled={plan?.kind !== "ready" || running}>
                {running
                  ? "Handing off…"
                  : `Hand off to ${machine?.environment.label ?? "machine"}`}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
