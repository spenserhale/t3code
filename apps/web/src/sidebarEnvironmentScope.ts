import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";

import type { ProjectGroupingSettings } from "./logicalProject";
import {
  resolveSidebarProjectScopeKey,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";

// The NUL keeps an environment scope key from ever equalling a project scope
// key, the same way the scratch project scope key stays clear of them.
const ENVIRONMENT_SCOPE_KEY_PREFIX = "\0environment:";

export interface SidebarEnvironmentScope {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectKeys: ReadonlySet<string>;
}

export function buildSidebarEnvironmentScopes(input: {
  readonly groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjectRefs">>;
  readonly environments: ReadonlyArray<Pick<SidebarEnvironmentScope, "environmentId" | "label">>;
}): ReadonlyArray<SidebarEnvironmentScope> {
  // Refs rather than memberProjects: grouping folds a stale duplicate row of a
  // workspace out of the members, but its threads remain and the project scope
  // keeps them too.
  const projectKeysByEnvironment = new Map<EnvironmentId, Set<string>>();
  for (const group of input.groups) {
    for (const projectRef of group.memberProjectRefs) {
      const projectKeys =
        projectKeysByEnvironment.get(projectRef.environmentId) ?? new Set<string>();
      projectKeys.add(scopedProjectKey(projectRef));
      projectKeysByEnvironment.set(projectRef.environmentId, projectKeys);
    }
  }
  // An environment without an identity gets no scope; its threads stay
  // reachable under all projects.
  const scopes = input.environments.flatMap(({ environmentId, label }) => {
    const projectKeys = projectKeysByEnvironment.get(environmentId);
    return projectKeys === undefined
      ? []
      : [
          {
            key: `${ENVIRONMENT_SCOPE_KEY_PREFIX}${environmentId}`,
            environmentId,
            label,
            projectKeys,
          },
        ];
  });
  // A single machine needs no machine filter.
  return scopes.length < 2 ? [] : scopes;
}

export function resolveSidebarScopeKey(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly environmentScopes: ReadonlyArray<Pick<SidebarEnvironmentScope, "key">>;
  readonly key: string | null;
  readonly settings?: ProjectGroupingSettings;
  readonly canClearMissingScope?: boolean;
}): string | null {
  if (input.key === null || !input.key.startsWith(ENVIRONMENT_SCOPE_KEY_PREFIX)) {
    return resolveSidebarProjectScopeKey(input);
  }
  if (input.environmentScopes.some((scope) => scope.key === input.key)) return input.key;
  return input.canClearMissingScope ? null : input.key;
}
