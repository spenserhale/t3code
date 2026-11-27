import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

import {
  resolveSidebarProjectScopeKeys,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";

// The NUL keeps an environment scope key from ever equalling a project scope
// key, the same way the scratch project scope key stays clear of them.
const ENVIRONMENT_SCOPE_KEY_PREFIX = "\0environment:";

export interface SidebarEnvironmentScope {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
}

type EnvironmentIdentity = Pick<SidebarEnvironmentScope, "environmentId" | "label">;
type ProjectRefGroup = Pick<SidebarProjectSnapshot, "memberProjectRefs">;

function projectRefsByEnvironment(groups: ReadonlyArray<ProjectRefGroup>) {
  // Refs rather than memberProjects: grouping folds a stale duplicate row of a
  // workspace out of the members, but its threads remain and the project scope
  // keeps them too.
  const projectRefs = new Map<EnvironmentId, ScopedProjectRef[]>();
  for (const group of groups) {
    for (const projectRef of group.memberProjectRefs) {
      const refs = projectRefs.get(projectRef.environmentId) ?? [];
      refs.push(projectRef);
      projectRefs.set(projectRef.environmentId, refs);
    }
  }
  return projectRefs;
}

function environmentScopeOf(
  environment: EnvironmentIdentity,
  projectRefs: ReadonlyArray<ScopedProjectRef>,
): SidebarEnvironmentScope {
  return {
    key: `${ENVIRONMENT_SCOPE_KEY_PREFIX}${environment.environmentId}`,
    environmentId: environment.environmentId,
    label: environment.label,
    projectRefs,
  };
}

/** The environments the menu lists. A chosen one resolves through `resolveChosenSidebarScope`. */
export function buildSidebarEnvironmentScopes(input: {
  readonly groups: ReadonlyArray<ProjectRefGroup>;
  readonly environments: ReadonlyArray<EnvironmentIdentity>;
}): ReadonlyArray<SidebarEnvironmentScope> {
  const refsByEnvironment = projectRefsByEnvironment(input.groups);
  // An environment without an identity gets no scope; its threads stay
  // reachable under all projects.
  const scopes = input.environments.flatMap((environment) => {
    const projectRefs = refsByEnvironment.get(environment.environmentId);
    return projectRefs === undefined ? [] : [environmentScopeOf(environment, projectRefs)];
  });
  // A single machine needs no machine filter.
  return scopes.length < 2 ? [] : scopes;
}

/** Project keys resolve as the project scope does; environment keys stay while listed or until clearing is safe. */
export function resolveSidebarScopeKeys(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly environmentScopes: ReadonlyArray<Pick<SidebarEnvironmentScope, "key">>;
  readonly keys: ReadonlyArray<string>;
  readonly settings?: ProjectGroupingSettings;
  readonly canClearMissingScope?: boolean;
}): string[] {
  const environmentScopeKeys = new Set(input.environmentScopes.map((scope) => scope.key));
  return [
    ...new Set(
      input.keys.flatMap((key) => {
        if (!key.startsWith(ENVIRONMENT_SCOPE_KEY_PREFIX)) {
          return resolveSidebarProjectScopeKeys({ ...input, keys: [key] });
        }
        return environmentScopeKeys.has(key) || !input.canClearMissingScope ? [key] : [];
      }),
    ),
  ];
}

/**
 * What the chosen keys cover: the chosen projects plus every project on each chosen environment.
 * A chosen environment resolves by its identity, listed or not, so one that is offline or still
 * loading keeps its name and covers no projects yet: an empty scope, not `null` for everything.
 */
export function resolveChosenSidebarScope(input: {
  readonly chosenGroups: ReadonlyArray<ProjectRefGroup>;
  readonly groups: ReadonlyArray<ProjectRefGroup>;
  readonly environments: ReadonlyArray<EnvironmentIdentity>;
  readonly keys: ReadonlyArray<string>;
}): {
  readonly environmentScopes: SidebarEnvironmentScope[];
  readonly projectRefs: ScopedProjectRef[];
  readonly projectKeys: ReadonlySet<string> | null;
} {
  const refsByEnvironment = projectRefsByEnvironment(input.groups);
  const environmentScopes = input.environments.flatMap((environment) => {
    const scope = environmentScopeOf(
      environment,
      refsByEnvironment.get(environment.environmentId) ?? [],
    );
    return input.keys.includes(scope.key) ? [scope] : [];
  });
  const projectRefs = [
    ...input.chosenGroups.flatMap((group) => group.memberProjectRefs),
    ...environmentScopes.flatMap((scope) => scope.projectRefs),
  ];
  return {
    environmentScopes,
    projectRefs,
    projectKeys:
      input.chosenGroups.length === 0 && environmentScopes.length === 0
        ? null
        : new Set(projectRefs.map(scopedProjectKey)),
  };
}

/**
 * Boring-sidebar folders under a scope: one for each group holding a project the scope covers.
 * A chosen project keeps its empty folder so a thread can start there; the other projects of a
 * chosen environment keep one only when pinned, as the unscoped list does.
 */
export function sidebarScopeFolders<
  TGroup extends Pick<
    SidebarProjectSnapshot,
    "projectKey" | "memberProjectRefs" | "pinned" | "archived"
  >,
>(input: {
  readonly groups: ReadonlyArray<TGroup>;
  readonly chosenGroups: ReadonlyArray<Pick<TGroup, "projectKey">>;
  readonly scopedProjectKeys: ReadonlySet<string>;
}): { readonly groups: TGroup[]; readonly keepEmpty: (group: TGroup) => boolean } {
  const chosenKeys = new Set(input.chosenGroups.map((group) => group.projectKey));
  return {
    groups: input.groups.filter((group) =>
      group.memberProjectRefs.some((projectRef) =>
        input.scopedProjectKeys.has(scopedProjectKey(projectRef)),
      ),
    ),
    keepEmpty: (group) => chosenKeys.has(group.projectKey) || (group.pinned && !group.archived),
  };
}

type FolderProject = Pick<SidebarProjectSnapshot, "environmentId" | "id" | "workspaceRoot">;

/**
 * The project a folder acts on, such as starting a thread in it. A folder that spans machines is
 * represented by one member, which a scope can leave out; then the first member the scope covers.
 */
export function sidebarScopeFolderProject(
  group: FolderProject & { readonly memberProjects: ReadonlyArray<FolderProject> },
  scopedProjectKeys: ReadonlySet<string> | null,
): FolderProject {
  if (scopedProjectKeys === null) return group;
  const covered = (project: FolderProject) =>
    scopedProjectKeys.has(
      scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
    );
  return covered(group) ? group : (group.memberProjects.find(covered) ?? group);
}
