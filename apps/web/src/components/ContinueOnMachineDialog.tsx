import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import {
  assessHandoffMachines,
  carriesHandoffCode,
  explainNoHandoffCode,
  isHandoffDefaultBranch,
  listHandoffSteps,
  planThreadMachineHandoff,
  type HandoffReady,
  type HandoffStep,
} from "@t3tools/client-runtime/thread-machine-handoff";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ScopedThreadRef, type VcsStatusResult } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { CheckIcon, CircleAlertIcon, CircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { continueOnChoiceOf, useHandoffEnvironments } from "../lib/handoffMachines";
import {
  runThreadMachineHandoff,
  type HandoffStepState,
  type ThreadMachineHandoffResult,
} from "../lib/threadMachineHandoff";
import { createThreadMachineHandoffIo } from "../lib/threadMachineHandoffIo";
import { isElectron } from "../env";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentMachines } from "../state/environments";
import { useProjects, useQuietThreadShell } from "../state/entities";
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

/** A link back to the thread that works in the client the user is in, when that has addresses. */
function threadLinkOf(threadRef: ScopedThreadRef): string | null {
  if (isElectron || typeof window === "undefined") return null;
  const { protocol, origin } = window.location;
  return protocol === "http:" || protocol === "https:"
    ? `${origin}/${threadRef.environmentId}/${threadRef.threadId}`
    : null;
}

type GitLoad =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly status: VcsStatusResult;
      /** The branch names a new handoff branch has to avoid; only read when it will be made. */
      readonly branchNames: ReadonlyArray<string>;
    }
  | { readonly kind: "failed"; readonly message: string };

function failureText(result: AtomCommandResult<unknown, unknown>, fallback: string): string {
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** Reads now, bypassing caches: the plan commits and pushes whatever is there. */
async function readGit(environmentId: EnvironmentId, cwd: string, title: string): Promise<GitLoad> {
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
  if (!isHandoffDefaultBranch(status)) return { kind: "ready", status, branchNames: [] };
  const refs = await runAtomCommand(
    appAtomRegistry,
    vcsEnvironment.readRefs,
    {
      environmentId,
      input: {
        cwd,
        query: `handoff/${sanitizeBranchFragment(title)}`,
        includeMatchingRemoteRefs: true,
        limit: 200,
      },
    },
    { reportFailure: false },
  );
  const branchNames =
    refs._tag === "Success"
      ? refs.value.refs.map((ref) =>
          ref.isRemote === true && ref.remoteName !== undefined
            ? ref.name.slice(ref.remoteName.length + 1)
            : ref.name,
        )
      : [];
  return { kind: "ready", status, branchNames };
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
    case "draft":
      return target.project === null
        ? `Open a thread without a project on ${target.label}`
        : `Open a draft on ${target.label}${projectTitle === null ? "" : ` in ${projectTitle}`}${
            code.kind === "carry" ? ", on a new worktree from that branch" : ""
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
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useHandoffEnvironments();
  const machineKinds = useEnvironmentMachines();
  const newThread = useNewThreadHandler();
  const { openScratchProject } = useScratchProject();

  const sourceLabel =
    environments.find((environment) => environment.environmentId === threadRef.environmentId)
      ?.label ?? "the other machine";
  const machines =
    source === null
      ? []
      : assessHandoffMachines({ source, projects, settings: groupingSettings, environments });
  const [chosenId, setChosenId] = useState(request.targetEnvironmentId);
  const machine =
    machines.find((candidate) => candidate.environment.environmentId === chosenId) ??
    machines.find((candidate) => candidate.status.kind === "ready") ??
    machines[0] ??
    null;

  const cwd =
    thread === null || source === null ? null : (thread.worktreePath ?? source.workspaceRoot);
  const readsGit = source !== null && cwd !== null && carriesHandoffCode(source);
  const [git, setGit] = useState<GitLoad>({ kind: "loading" });
  const title = thread?.title ?? "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the checkout's full status once from its machine; the live stream omits upstream counts until its remote half arrives
  useEffect(() => {
    if (!readsGit || cwd === null) return;
    let stale = false;
    void readGit(threadRef.environmentId, cwd, title).then((next) => {
      if (!stale) setGit(next);
    });
    return () => {
      stale = true;
    };
  }, [readsGit, cwd, threadRef.environmentId, title]);
  const gitStatus = git.kind === "ready" ? git.status : null;
  const existingBranchNames = git.kind === "ready" ? git.branchNames : [];

  const plan =
    thread === null || source === null || machine === null
      ? null
      : planThreadMachineHandoff({
          thread: {
            title: thread.title,
            modelSelection: thread.modelSelection,
            runStatus: thread.runtime?.status ?? null,
            hasPendingApproval: thread.hasPendingApprovals,
          },
          source,
          machine,
          git: gitStatus,
          existingBranchNames,
        });

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Partial<Record<HandoffStep, HandoffStepState>>>({});
  const [failure, setFailure] = useState<Extract<ThreadMachineHandoffResult, { ok: false }> | null>(
    null,
  );

  const submit = async () => {
    if (plan?.kind !== "ready" || thread === null || cwd === null || running) return;
    setRunning(true);
    setFailure(null);
    setSteps({});
    const result = await runThreadMachineHandoff({
      plan,
      title: thread.title,
      sourceLabel,
      threadLink: threadLinkOf(threadRef),
      io: createThreadMachineHandoffIo({
        plan,
        thread,
        cwd,
        sourceLabel,
        newThread,
        openScratchProject: (environmentId) => openScratchProject(environmentId),
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
      void readGit(threadRef.environmentId, cwd, thread.title).then(setGit);
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
