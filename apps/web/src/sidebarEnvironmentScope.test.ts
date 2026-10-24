import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterSidebarV2VisibleThreads,
  groupSidebarThreadsByProject,
} from "./components/Sidebar.logic";
import {
  buildSidebarEnvironmentScopes,
  resolveChosenSidebarScope,
  resolveSidebarScopeKeys,
  sidebarScopeFolderProject,
  sidebarScopeFolders,
} from "./sidebarEnvironmentScope";
import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import { makeThreadFixture } from "./test-fixtures";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const idleEnvironmentId = EnvironmentId.make("env-idle");
const primaryIdentity = { environmentId: primaryEnvironmentId, label: "This Mac" };
const remoteIdentity = { environmentId: remoteEnvironmentId, label: "Build box" };
const idleIdentity = { environmentId: idleEnvironmentId, label: "Spare box" };
const sharedRepository = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "project",
    workspaceRoot: "/work/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function groupsOf(projects: ReadonlyArray<Project>) {
  return buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  });
}

describe("buildSidebarEnvironmentScopes", () => {
  it("offers no environment scope while one environment owns every project", () => {
    const groups = groupsOf([
      makeProject(),
      makeProject({ id: ProjectId.make("project-2"), workspaceRoot: "/work/other" }),
    ]);

    expect(
      buildSidebarEnvironmentScopes({ groups, environments: [primaryIdentity, remoteIdentity] }),
    ).toEqual([]);
  });

  it("scopes each environment that owns projects, in identity order, across spanning groups", () => {
    const groups = groupsOf([
      makeProject({
        id: ProjectId.make("shared-primary"),
        workspaceRoot: "/work/shared",
        repositoryIdentity: sharedRepository,
      }),
      makeProject({
        id: ProjectId.make("shared-remote"),
        environmentId: remoteEnvironmentId,
        workspaceRoot: "/srv/shared",
        repositoryIdentity: sharedRepository,
      }),
      makeProject({ id: ProjectId.make("solo-primary"), workspaceRoot: "/work/solo" }),
    ]);
    expect(groups).toHaveLength(2);

    const scopes = buildSidebarEnvironmentScopes({
      groups,
      environments: [remoteIdentity, primaryIdentity],
    });

    expect(
      scopes.map(({ environmentId, label, projectRefs }) => ({
        environmentId,
        label,
        projectKeys: projectRefs.map(scopedProjectKey),
      })),
    ).toEqual([
      {
        environmentId: remoteEnvironmentId,
        label: "Build box",
        projectKeys: ["env-remote:shared-remote"],
      },
      {
        environmentId: primaryEnvironmentId,
        label: "This Mac",
        projectKeys: ["env-primary:shared-primary", "env-primary:solo-primary"],
      },
    ]);
  });

  it("omits an environment that owns no projects", () => {
    const groups = groupsOf([
      makeProject(),
      makeProject({
        id: ProjectId.make("remote-project"),
        environmentId: remoteEnvironmentId,
        workspaceRoot: "/srv/project",
      }),
    ]);

    const scopes = buildSidebarEnvironmentScopes({
      groups,
      environments: [primaryIdentity, idleIdentity, remoteIdentity],
    });

    expect(scopes.map((scope) => scope.environmentId)).toEqual([
      primaryEnvironmentId,
      remoteEnvironmentId,
    ]);
  });

  it("builds scopes only from environments that have an identity", () => {
    const unknownEnvironmentId = EnvironmentId.make("env-unknown");
    const groups = groupsOf([
      makeProject(),
      makeProject({
        id: ProjectId.make("remote-project"),
        environmentId: remoteEnvironmentId,
        workspaceRoot: "/srv/project",
      }),
      makeProject({
        id: ProjectId.make("unknown-project"),
        environmentId: unknownEnvironmentId,
        workspaceRoot: "/unknown/project",
      }),
    ]);

    expect(
      buildSidebarEnvironmentScopes({
        groups,
        environments: [primaryIdentity, remoteIdentity],
      }).map((scope) => scope.environmentId),
    ).toEqual([primaryEnvironmentId, remoteEnvironmentId]);
    expect(buildSidebarEnvironmentScopes({ groups, environments: [primaryIdentity] })).toEqual([]);
  });

  it("keeps stale duplicate project rows, as the project scope does", () => {
    const current = makeProject({
      id: ProjectId.make("current"),
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const stale = makeProject({ id: ProjectId.make("stale") });
    const groups = groupsOf([
      current,
      stale,
      makeProject({
        id: ProjectId.make("remote-project"),
        environmentId: remoteEnvironmentId,
        workspaceRoot: "/srv/project",
      }),
    ]);
    expect(
      groups.flatMap((group) => group.memberProjects.map((member) => member.id)),
    ).not.toContain(stale.id);

    const [primaryScope] = buildSidebarEnvironmentScopes({
      groups,
      environments: [primaryIdentity, remoteIdentity],
    });

    expect(primaryScope?.projectRefs.map(scopedProjectKey).toSorted()).toEqual([
      "env-primary:current",
      "env-primary:stale",
    ]);
  });
});

describe("resolveSidebarScopeKeys", () => {
  const groups = groupsOf([
    makeProject(),
    makeProject({
      id: ProjectId.make("remote-project"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/srv/project",
    }),
  ]);
  const environmentScopes = buildSidebarEnvironmentScopes({
    groups,
    environments: [primaryIdentity, remoteIdentity],
  });
  const primaryScope = environmentScopes[0]!;
  const remoteScope = environmentScopes[1]!;
  const projectKey = groups[0]!.projectKey;

  it("keeps environment keys beside project keys while their scopes exist", () => {
    expect(
      resolveSidebarScopeKeys({
        groups,
        environmentScopes,
        keys: [remoteScope.key, projectKey, remoteScope.key],
        canClearMissingScope: true,
      }),
    ).toEqual([remoteScope.key, projectKey]);
  });

  it("keeps an environment key without a scope until clearing is safe", () => {
    expect(
      resolveSidebarScopeKeys({
        groups,
        environmentScopes: [primaryScope],
        keys: [remoteScope.key],
      }),
    ).toEqual([remoteScope.key]);
    expect(
      resolveSidebarScopeKeys({
        groups,
        environmentScopes: [primaryScope],
        keys: [remoteScope.key, projectKey],
        canClearMissingScope: true,
      }),
    ).toEqual([projectKey]);
  });

  it("leaves other keys to project scope resolution", () => {
    expect(
      resolveSidebarScopeKeys({
        groups,
        environmentScopes,
        keys: ["missing-project", primaryScope.key],
        canClearMissingScope: true,
      }),
    ).toEqual([primaryScope.key]);
    expect(
      resolveSidebarScopeKeys({ groups, environmentScopes, keys: ["missing-project"] }),
    ).toEqual(["missing-project"]);
  });
});

describe("resolveChosenSidebarScope", () => {
  const environments = [primaryIdentity, remoteIdentity, idleIdentity];
  const primaryProject = makeProject({
    id: ProjectId.make("primary-project"),
    title: "primary-project",
    workspaceRoot: "/work/primary",
  });
  const remoteProject = makeProject({
    id: ProjectId.make("remote-project"),
    title: "remote-project",
    environmentId: remoteEnvironmentId,
    workspaceRoot: "/srv/remote",
  });
  const idleProject = makeProject({
    id: ProjectId.make("idle-project"),
    title: "idle-project",
    environmentId: idleEnvironmentId,
    workspaceRoot: "/srv/idle",
  });
  const keyOf = (groups: ReturnType<typeof groupsOf>, environmentId: EnvironmentId) =>
    buildSidebarEnvironmentScopes({ groups, environments }).find(
      (scope) => scope.environmentId === environmentId,
    )!.key;

  it("covers the chosen projects and every project on each chosen environment", () => {
    const groups = groupsOf([primaryProject, remoteProject, idleProject]);

    const scope = resolveChosenSidebarScope({
      chosenGroups: groups.filter((group) => group.displayName === "primary-project"),
      groups,
      environments,
      keys: [keyOf(groups, idleEnvironmentId)],
    });

    expect(scope.environmentScopes.map((chosen) => chosen.environmentId)).toEqual([
      idleEnvironmentId,
    ]);
    expect(scope.projectKeys).toEqual(
      new Set(["env-primary:primary-project", "env-idle:idle-project"]),
    );
  });

  it("has no scope while nothing is chosen", () => {
    const groups = groupsOf([primaryProject, remoteProject]);

    expect(resolveChosenSidebarScope({ chosenGroups: [], groups, environments, keys: [] })).toEqual(
      { environmentScopes: [], projectRefs: [], projectKeys: null },
    );
  });

  it("keeps an environment chosen while its projects are unavailable, covering nothing", () => {
    const idleKey = keyOf(
      groupsOf([primaryProject, remoteProject, idleProject]),
      idleEnvironmentId,
    );
    const groups = groupsOf([primaryProject, remoteProject]);
    const listed = buildSidebarEnvironmentScopes({ groups, environments });
    expect(listed.map((scope) => scope.environmentId)).toEqual([
      primaryEnvironmentId,
      remoteEnvironmentId,
    ]);

    const keys = resolveSidebarScopeKeys({ groups, environmentScopes: listed, keys: [idleKey] });
    const scope = resolveChosenSidebarScope({ chosenGroups: [], groups, environments, keys });

    expect(keys).toEqual([idleKey]);
    expect(
      scope.environmentScopes.map(({ environmentId, label }) => ({ environmentId, label })),
    ).toEqual([idleIdentity]);
    expect(scope.projectKeys).toEqual(new Set());
    const threads = [
      makeThreadFixture({
        id: ThreadId.make("primary-thread"),
        environmentId: primaryEnvironmentId,
        projectId: primaryProject.id,
      }),
    ];
    expect(filterSidebarV2VisibleThreads(threads, scope.projectKeys, new Set())).toEqual([]);

    const cleared = resolveSidebarScopeKeys({
      groups,
      environmentScopes: listed,
      keys: [idleKey],
      canClearMissingScope: true,
    });
    expect(cleared).toEqual([]);
    expect(
      resolveChosenSidebarScope({ chosenGroups: [], groups, environments, keys: cleared })
        .projectKeys,
    ).toBeNull();
  });

  it("does not scope to an environment the connections no longer list", () => {
    const groups = groupsOf([primaryProject, remoteProject]);
    const remoteKey = keyOf(groups, remoteEnvironmentId);

    expect(
      resolveChosenSidebarScope({
        chosenGroups: [],
        groups,
        environments: [primaryIdentity],
        keys: [remoteKey],
      }),
    ).toEqual({ environmentScopes: [], projectRefs: [], projectKeys: null });
  });
});

describe("sidebarScopeFolders", () => {
  const environments = [primaryIdentity, remoteIdentity];
  const project = (title: string, environmentId: EnvironmentId, pinned = false) =>
    makeProject({
      id: ProjectId.make(title),
      environmentId,
      title,
      workspaceRoot: `/work/${title}`,
      pinnedAt: pinned ? "2026-01-01T00:00:00.000Z" : null,
    });
  const groups = groupsOf([
    project("alpha", primaryEnvironmentId),
    project("gamma", primaryEnvironmentId, true),
    project("beta", remoteEnvironmentId),
    project("beta-pinned", remoteEnvironmentId, true),
    project("beta-quiet", remoteEnvironmentId),
  ]);
  const group = (title: string) => groups.find((candidate) => candidate.displayName === title)!;
  const remoteKey = buildSidebarEnvironmentScopes({ groups, environments })[1]!.key;
  const threads = [
    makeThreadFixture({
      id: ThreadId.make("alpha-thread"),
      environmentId: primaryEnvironmentId,
      projectId: ProjectId.make("alpha"),
    }),
    makeThreadFixture({
      id: ThreadId.make("beta-thread"),
      environmentId: remoteEnvironmentId,
      projectId: ProjectId.make("beta"),
    }),
  ];

  function foldersOf(chosenTitles: ReadonlyArray<string>, environmentKeys: ReadonlyArray<string>) {
    const chosenGroups = chosenTitles.map(group);
    const scope = resolveChosenSidebarScope({
      chosenGroups,
      groups,
      environments,
      keys: [...chosenGroups.map((chosen) => chosen.projectKey), ...environmentKeys],
    });
    const scopedProjectKeys = scope.projectKeys!;
    const folders = sidebarScopeFolders({ groups, chosenGroups, scopedProjectKeys });
    const visible = filterSidebarV2VisibleThreads(threads, scopedProjectKeys, new Set());
    return Object.fromEntries(
      groupSidebarThreadsByProject(folders.groups, visible, folders.keepEmpty).map((folder) => [
        folder.group.displayName,
        folder.threads.map((thread) => thread.id),
      ]),
    );
  }

  it("folds the threads of a chosen environment beside a chosen project", () => {
    expect(foldersOf(["alpha"], [remoteKey])).toEqual({
      alpha: ["alpha-thread"],
      beta: ["beta-thread"],
      "beta-pinned": [],
    });
  });

  it("leaves out folders outside the scope, even a pinned one", () => {
    expect(foldersOf([], [remoteKey])).toEqual({ beta: ["beta-thread"], "beta-pinned": [] });
  });

  it("keeps a chosen project's empty folder", () => {
    expect(foldersOf(["beta-quiet"], [])).toEqual({ "beta-quiet": [] });
  });
});

describe("sidebarScopeFolderProject", () => {
  const environments = [primaryIdentity, remoteIdentity];
  const sharedProject = (environmentId: EnvironmentId) =>
    makeProject({
      id: ProjectId.make(`shared-${environmentId}`),
      environmentId,
      title: "shared",
      workspaceRoot: `/work/${environmentId}/shared`,
      repositoryIdentity: sharedRepository,
    });
  const groups = groupsOf([
    sharedProject(primaryEnvironmentId),
    sharedProject(remoteEnvironmentId),
  ]);
  const folder = groups[0]!;
  const keyOf = (environmentId: EnvironmentId) =>
    buildSidebarEnvironmentScopes({ groups, environments }).find(
      (scope) => scope.environmentId === environmentId,
    )!.key;
  const projectKeysOf = (chosenGroups: typeof groups, environmentKeys: ReadonlyArray<string>) =>
    resolveChosenSidebarScope({
      chosenGroups,
      groups,
      environments,
      keys: [...chosenGroups.map((chosen) => chosen.projectKey), ...environmentKeys],
    }).projectKeys;

  it("acts on the member a scope covers when the representative is outside it", () => {
    expect(groups).toHaveLength(1);
    expect(folder.environmentId).toBe(primaryEnvironmentId);

    expect(
      sidebarScopeFolderProject(folder, projectKeysOf([], [keyOf(remoteEnvironmentId)])),
    ).toMatchObject({
      environmentId: remoteEnvironmentId,
      id: "shared-env-remote",
      workspaceRoot: "/work/env-remote/shared",
    });
  });

  it("keeps the representative without a scope, under a chosen project, or when it is covered", () => {
    expect(sidebarScopeFolderProject(folder, null)).toBe(folder);
    expect(sidebarScopeFolderProject(folder, projectKeysOf([folder], []))).toBe(folder);
    expect(
      sidebarScopeFolderProject(folder, projectKeysOf([], [keyOf(primaryEnvironmentId)])),
    ).toBe(folder);
  });
});
