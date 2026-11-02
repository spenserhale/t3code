import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentPresentationWithProviders } from "@t3tools/client-runtime/state/presentation";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  assessHandoffMachines,
  type HandoffEnvironment,
  type HandoffMachine,
} from "@t3tools/client-runtime/thread-machine-handoff";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readProjects, readThreadShell } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../state/session";

export interface ContinueOnChoice {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly disabled: boolean;
}

function toHandoffEnvironments(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
  can: {
    readonly operate: (environmentId: EnvironmentId) => boolean;
    readonly sourceControl: (environmentId: EnvironmentId) => boolean;
  },
): ReadonlyArray<HandoffEnvironment> {
  return [...presentations].map(([environmentId, presentation]) => {
    const { serverConfig } = presentation;
    const connected = presentation.connection.phase === "connected" && serverConfig !== null;
    const advertisedFileBytes =
      serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
    return {
      environmentId,
      label: presentation.entry.target.label,
      connected,
      canOperate: can.operate(environmentId),
      canAddProject: connected && can.sourceControl(environmentId),
      scratchAvailable:
        availableScratchWorkspaceRoot(presentation.connection.phase, serverConfig) !== null,
      providers: serverConfig?.providers ?? [],
      maxFileBytes:
        advertisedFileBytes === null ? null : clampFileAttachmentUploadBytes(advertisedFileBytes),
    };
  });
}

export function useHandoffEnvironments(): ReadonlyArray<HandoffEnvironment> {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const environments = [...presentations.keys()].map((environmentId) => ({ environmentId }));
  const operate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const sourceControl = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);
  return toHandoffEnvironments(presentations, {
    operate: (environmentId) => operate.has(environmentId),
    sourceControl: (environmentId) => sourceControl.has(environmentId),
  });
}

function readHandoffEnvironments(): ReadonlyArray<HandoffEnvironment> {
  return toHandoffEnvironments(
    appAtomRegistry.get(environmentPresentations.presentationsWithProvidersAtom),
    {
      operate: (environmentId) =>
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
      sourceControl: (environmentId) =>
        readEnvironmentScope(environmentId, AuthSourceControlWriteScope),
    },
  );
}

const UNAVAILABLE_HINT = {
  offline: "offline",
  "read-only": "read-only",
  "no-folder": "no folder",
} as const;

/** A machine as the thread menu and the dialog's picker list it. */
export function continueOnChoiceOf(machine: HandoffMachine): ContinueOnChoice {
  const { environment, status } = machine;
  const hint =
    status.kind === "unavailable"
      ? UNAVAILABLE_HINT[status.reason]
      : status.kind === "needs-project"
        ? status.canAdd
          ? "add project"
          : "no project"
        : null;
  return {
    environmentId: environment.environmentId,
    label: hint === null ? environment.label : `${environment.label} (${hint})`,
    disabled: status.kind === "unavailable" || (status.kind === "needs-project" && !status.canAdd),
  };
}

/** The other machines the thread could go to, read now for a menu that is about to open. */
export function readContinueOnChoices(threadRef: ScopedThreadRef): ReadonlyArray<ContinueOnChoice> {
  const thread = readThreadShell(threadRef);
  const source =
    thread === null ? null : readProject(scopeProjectRef(thread.environmentId, thread.projectId));
  if (source === null) return [];
  return assessHandoffMachines({
    source,
    projects: readProjects(),
    settings: selectProjectGroupingSettings(getClientSettings()),
    environments: readHandoffEnvironments(),
  }).map(continueOnChoiceOf);
}
