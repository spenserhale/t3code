import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarEnvironmentScopes, resolveSidebarScopeKey } from "./sidebarEnvironmentScope";
import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
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
      scopes.map(({ environmentId, label, projectKeys }) => ({
        environmentId,
        label,
        projectKeys,
      })),
    ).toEqual([
      {
        environmentId: remoteEnvironmentId,
        label: "Build box",
        projectKeys: new Set(["env-remote:shared-remote"]),
      },
      {
        environmentId: primaryEnvironmentId,
        label: "This Mac",
        projectKeys: new Set(["env-primary:shared-primary", "env-primary:solo-primary"]),
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

    expect(primaryScope?.projectKeys).toEqual(
      new Set(["env-primary:current", "env-primary:stale"]),
    );
  });
});

describe("resolveSidebarScopeKey", () => {
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

  it("keeps an environment key while its scope exists", () => {
    expect(
      resolveSidebarScopeKey({
        groups,
        environmentScopes,
        key: remoteScope.key,
        canClearMissingScope: true,
      }),
    ).toBe(remoteScope.key);
  });

  it("keeps an environment key without a scope until clearing is safe", () => {
    expect(
      resolveSidebarScopeKey({ groups, environmentScopes: [primaryScope], key: remoteScope.key }),
    ).toBe(remoteScope.key);
    expect(
      resolveSidebarScopeKey({
        groups,
        environmentScopes: [primaryScope],
        key: remoteScope.key,
        canClearMissingScope: false,
      }),
    ).toBe(remoteScope.key);
  });

  it("clears an environment key without a scope once clearing is safe", () => {
    expect(
      resolveSidebarScopeKey({
        groups,
        environmentScopes: [primaryScope],
        key: remoteScope.key,
        canClearMissingScope: true,
      }),
    ).toBeNull();
  });

  it("leaves other keys to project scope resolution", () => {
    const projectKey = groups[0]!.projectKey;

    expect(
      resolveSidebarScopeKey({
        groups,
        environmentScopes,
        key: projectKey,
        canClearMissingScope: true,
      }),
    ).toBe(projectKey);
    expect(
      resolveSidebarScopeKey({
        groups,
        environmentScopes,
        key: "missing-project",
        canClearMissingScope: true,
      }),
    ).toBeNull();
    expect(resolveSidebarScopeKey({ groups, environmentScopes, key: "missing-project" })).toBe(
      "missing-project",
    );
    expect(resolveSidebarScopeKey({ groups, environmentScopes, key: null })).toBeNull();
  });
});
