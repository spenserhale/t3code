import type { EnvironmentId } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";

export interface SettingsScopeSearch {
  project?: string | undefined;
  machine?: string | undefined;
  machines?: readonly string[] | undefined;
  checkout?: string | undefined;
}

type ScopeTargets = {
  label: string;
  members: readonly SidebarProjectGroupMember[];
  environmentIds: readonly EnvironmentId[];
};

export type ResolvedSettingsScope = ScopeTargets &
  (
    | { kind: "all" }
    | { kind: "environment"; environmentId: EnvironmentId }
    | { kind: "environments" }
    | {
        kind: "project";
        group: SidebarProjectSnapshot;
        environmentId: EnvironmentId | null;
      }
    | {
        kind: "checkout";
        group: SidebarProjectSnapshot;
        checkout: SidebarProjectGroupMember;
        environmentId: EnvironmentId;
      }
    | {
        kind: "unavailable";
        reason: "project-required" | "project-missing" | "environment-missing" | "checkout-missing";
        message: string;
      }
  );

/** Stale IDs remain visible to the resolver so a removed target reads as unavailable, not as "all". */
export function validateSettingsScopeSearch(raw: Record<string, unknown>): SettingsScopeSearch {
  const isNonemptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const stringValue = (value: unknown) => (isNonemptyString(value) ? value : undefined);
  const project = stringValue(raw.project);
  const machine = stringValue(raw.machine);
  const checkout = stringValue(raw.checkout);
  const machines =
    machine === undefined && raw.machines !== undefined
      ? Array.isArray(raw.machines)
        ? [...new Set(raw.machines.filter(isNonemptyString))]
        : []
      : undefined;
  return {
    ...(project === undefined ? {} : { project }),
    ...(machine === undefined ? {} : { machine }),
    ...(machines === undefined ? {} : { machines }),
    ...(checkout === undefined ? {} : { checkout }),
  };
}

/** An unavailable selection never broadens a subsequent write. */
export function resolveSettingsScope(
  search: SettingsScopeSearch,
  groups: readonly SidebarProjectSnapshot[],
  environments: readonly Pick<EnvironmentPresentation, "environmentId" | "label">[],
): ResolvedSettingsScope {
  const unavailable = (
    reason: Extract<ResolvedSettingsScope, { kind: "unavailable" }>["reason"],
    message: string,
  ): ResolvedSettingsScope => ({
    kind: "unavailable",
    reason,
    label: "Unavailable selection",
    message,
    members: [],
    environmentIds: [],
  });

  if (search.checkout && !search.project) {
    return unavailable("project-required", "Select a project to choose one of its checkouts.");
  }

  const requestedIds = search.machine === undefined ? search.machines : [search.machine];
  const selectedEnvironments =
    requestedIds === undefined
      ? environments
      : environments.filter((environment) => requestedIds.includes(environment.environmentId));
  const environmentIds = selectedEnvironments.map((environment) => environment.environmentId);
  if (requestedIds !== undefined && environmentIds.length === 0) {
    return unavailable(
      "environment-missing",
      search.machine
        ? "This environment is no longer available."
        : "Select an available environment to change its settings.",
    );
  }
  const environment =
    requestedIds !== undefined && selectedEnvironments.length === 1
      ? selectedEnvironments[0]
      : undefined;

  if (search.project) {
    const group = groups.find((candidate) => candidate.projectKey === search.project);
    if (!group) return unavailable("project-missing", "This project is no longer available.");
    const members = group.memberProjects.filter(
      (member) =>
        (requestedIds === undefined || environmentIds.includes(member.environmentId)) &&
        (search.checkout === undefined || member.physicalProjectKey === search.checkout),
    );
    if (members.length === 0) {
      return unavailable(
        "checkout-missing",
        search.checkout
          ? "This checkout is no longer available in the selected project and environment."
          : search.machine
            ? "This project has no checkout on this environment."
            : "This project has no checkout on the selected environments.",
      );
    }
    if (search.checkout) {
      const checkout = members[0]!;
      const checkoutEnvironment = environments.find(
        (candidate) => candidate.environmentId === checkout.environmentId,
      );
      if (!checkoutEnvironment) {
        return unavailable(
          "environment-missing",
          "This checkout's environment is no longer available.",
        );
      }
      const sharesEnvironment = group.memberProjects.some(
        (member) =>
          member.environmentId === checkout.environmentId &&
          member.physicalProjectKey !== checkout.physicalProjectKey,
      );
      return {
        kind: "checkout",
        group,
        checkout,
        environmentId: checkout.environmentId,
        label: `${group.displayName} / ${checkoutEnvironment.label}${sharesEnvironment ? ` · ${checkout.workspaceRoot}` : ""}`,
        members,
        environmentIds: [checkout.environmentId],
      };
    }
    const memberEnvironmentIds = [...new Set(members.map((member) => member.environmentId))];
    const memberEnvironmentLabel =
      memberEnvironmentIds.length === 1
        ? selectedEnvironments.find(
            ({ environmentId }) => environmentId === memberEnvironmentIds[0],
          )?.label
        : `${memberEnvironmentIds.length} environments`;
    return {
      kind: "project",
      group,
      environmentId: environment?.environmentId ?? null,
      label: `${group.displayName} / ${requestedIds === undefined ? "All checkouts" : memberEnvironmentLabel}`,
      members,
      environmentIds: memberEnvironmentIds,
    };
  }
  if (environment) {
    return {
      kind: "environment",
      environmentId: environment.environmentId,
      label: environment.label,
      members: [],
      environmentIds: [environment.environmentId],
    };
  }
  if (requestedIds !== undefined) {
    return {
      kind: "environments",
      label: `${environmentIds.length} environments`,
      members: [],
      environmentIds,
    };
  }
  return {
    kind: "all",
    label: "All environments",
    members: [],
    environmentIds,
  };
}
