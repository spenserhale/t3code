import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  applyPendingScopedWrites,
  createScopedSettingsWriter,
  describeOfflineScope,
  describeScopedSave,
  offlineScopedEnvironments,
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedProviderEffortSliderWrite,
  planScopedModelDefaults,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedIdleCompaction,
  resolveScopedSettingsTargets,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  selectScopedSettingsEnvironments,
  settlePendingScopedWrites,
  type PendingScopedWrite,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

function environment(
  id: string,
  options: {
    connected?: boolean;
    loaded?: boolean;
    settings?: Partial<ServerSettings>;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: {
      phase: options.connected === false ? ("offline" as const) : ("connected" as const),
    },
    serverConfig:
      options.loaded === false
        ? null
        : {
            settings: { ...DEFAULT_SERVER_SETTINGS, ...options.settings },
          },
  };
}

const laptop = environment("Laptop");
const server = environment("Server");
const offline = environment("Offline", { connected: false });
const loading = environment("Loading", { loaded: false });
const environments = [laptop, server, offline, loading];
const all = resolveSettingsScope({}, [], environments);
const named = resolveSettingsScope({ machine: server.environmentId }, [], environments);

const projectId = ProjectId.make("project");
const laptopProjectId = ProjectId.make("laptop-project");
const member = {
  id: projectId,
  environmentId: server.environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: `${server.environmentId}:/repo`,
  environmentLabel: server.label,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const laptopMember = {
  ...member,
  id: laptopProjectId,
  environmentId: laptop.environmentId,
  physicalProjectKey: `${laptop.environmentId}:/repo`,
  environmentLabel: laptop.label,
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member, laptopMember],
  memberProjectRefs: [
    { environmentId: server.environmentId, projectId },
    { environmentId: laptop.environmentId, projectId: laptopProjectId },
  ],
  groupedProjectCount: 2,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [server.label, laptop.label],
  pinned: false,
  archived: false,
};
const project = resolveSettingsScope({ project: group.projectKey }, [group], environments);
const checkout = resolveSettingsScope(
  { project: group.projectKey, machine: server.environmentId, checkout: member.physicalProjectKey },
  [group],
  environments,
);

describe("scoped settings targets", () => {
  it("uses the named environment even when a different primary is available", () => {
    const selected = selectScopedSettingsEnvironments(named, environments, laptop.environmentId);
    expect(selected.environments).toEqual([server]);
    expect(selected.environment).toBe(server);
  });

  it("keeps an offline named environment selected without falling back to primary", () => {
    const scope = resolveSettingsScope({ machine: offline.environmentId }, [], environments);
    const selected = selectScopedSettingsEnvironments(scope, environments, laptop.environmentId);
    expect(selected.environments).toEqual([offline]);
    expect(selected.connectedEnvironments).toEqual([]);
    expect(selected.environment).toBeNull();
    expect(
      planScopedSettingsPatch(scope, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "Connect Offline to save this setting.",
    });
  });

  it("resolves each member's effective settings and source at project scope", () => {
    const overridden = environment("Server", {
      settings: {
        defaultAutoPull: false,
        projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
      },
    });
    const targets = resolveScopedSettingsTargets(project, [laptop, overridden]);
    expect(targets.map((target) => [target.projectId, target.settings.defaultAutoPull])).toEqual([
      [projectId, true],
      [laptopProjectId, false],
    ]);
    expect(scopedSettingsSource(targets, ["defaultAutoPull"])).toBe("mixed");
    expect(scopedSettingsSource([targets[0]!], ["defaultAutoPull"])).toBe("project");
    expect(scopedSettingsSource(targets, ["enableProviderUpdateChecks"])).toBe("environment");
    expect(scopedSettingsAreMixed(targets, ["defaultAutoPull"])).toBe(true);
  });
});

describe("scoped settings writes", () => {
  it("targets each connected checkout with an edit for only the chosen provider", () => {
    const driver = ProviderDriverKind.make("opencode");
    const projectTargets = resolveScopedSettingsTargets(project, [laptop, server]);
    const plan = planScopedProviderEffortSliderWrite(projectTargets, driver, null);
    expect(plan.serverWrites.map(({ environmentId, patch }) => ({ environmentId, patch }))).toEqual(
      [
        {
          environmentId: server.environmentId,
          patch: { setProviderEffortSliders: [{ driver, projectId, steps: null }] },
        },
        {
          environmentId: laptop.environmentId,
          patch: {
            setProviderEffortSliders: [{ driver, projectId: laptopProjectId, steps: null }],
          },
        },
      ],
    );
    const environmentTargets = resolveScopedSettingsTargets(named, [server]);
    expect(
      planScopedProviderEffortSliderWrite(environmentTargets, driver, null).serverWrites[0]?.patch,
    ).toEqual({ setProviderEffortSliders: [{ driver, steps: null }] });
  });

  it("edits the effective machine policy without changing other machines' rules", () => {
    const custom = environment("Laptop", {
      settings: {
        worktreeCleanup: {
          mode: "custom",
          rules: {
            worktreeAfterDays: 12,
            worktreeSettledAfterDays: null,
            worktreeOnDelete: true,
            worktreeOnMerge: true,
            worktreeUnchanged: false,
            worktreeKeepWhen: "uncommitted-changes",
          },
        },
      },
    });
    const disabled = environment("Server", {
      settings: { worktreeCleanup: { mode: "off" } },
    });
    const targets = [custom, disabled];
    const plan = planScopedSettingsPatch(all, targets, {
      storageCleanup: { worktreeOnDelete: false },
    });
    const policies = plan.serverWrites.map((write, index) =>
      resolveWorktreeCleanup(
        applyServerSettingsPatch(targets[index]!.serverConfig!.settings, write.patch),
        null,
      ),
    );
    expect(policies).toEqual([
      {
        worktreeAfterDays: 12,
        worktreeSettledAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: true,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
      {
        worktreeAfterDays: null,
        worktreeSettledAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: false,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
    ]);
  });

  it("compares idle compaction by mode, and offers Never only where every server stores it", () => {
    const fixed = {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        compactIdleThreads: false,
        idleCompaction: "onReturn" as const,
      },
    };
    const modes = {
      settings: { ...DEFAULT_SERVER_SETTINGS, compactIdleThreads: "onReturn" as const },
    };
    const legacy = { settings: { ...DEFAULT_SERVER_SETTINGS, compactIdleThreads: false } };
    expect(scopedIdleCompaction([fixed, modes])).toEqual({ mixed: false, neverAvailable: true });
    expect(scopedIdleCompaction([fixed, legacy])).toEqual({ mixed: false, neverAvailable: false });
    const legacyEnvironment = environment("Legacy", { settings: legacy.settings });
    const projected = applyPendingScopedWrites(
      [legacyEnvironment],
      [
        {
          save: {},
          environmentId: legacyEnvironment.environmentId,
          patch: { defaultRuntimeMode: "auto" },
        },
      ],
    );
    expect(scopedIdleCompaction(resolveScopedSettingsTargets(all, projected)).neverAvailable).toBe(
      false,
    );
    expect(
      scopedIdleCompaction([fixed, { settings: { ...fixed.settings, idleCompaction: "off" } }])
        .mixed,
    ).toBe(true);
  });

  it("sends an idle compaction mode in the form each environment's server reads", () => {
    const targets = [
      environment("Fixed", { settings: { compactIdleThreads: false, idleCompaction: "onReturn" } }),
      environment("Modes", { settings: { compactIdleThreads: "onReturn" } }),
      environment("Switch", { settings: { compactIdleThreads: false } }),
    ];
    const plan = planScopedSettingsPatch(resolveSettingsScope({}, [], targets), targets, {
      idleCompaction: "beforeCacheExpires",
    });
    expect(plan.serverWrites.map((write) => write.patch)).toEqual([
      { idleCompaction: "beforeCacheExpires" },
      { compactIdleThreads: "beforeCacheExpires" },
      { compactIdleThreads: true },
    ]);
  });

  it("writes an aggregate preference only to connected environments with loaded configuration", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(all, environments, { enableProviderUpdateChecks: false }),
      persistServer,
      persistClient,
    );
    expect(persistServer.mock.calls.map(([input]) => input.environmentId)).toEqual([
      laptop.environmentId,
      server.environmentId,
    ]);
    expect(persistClient).not.toHaveBeenCalled();
  });

  describe("an environment that saves but drops keys it does not know", () => {
    const upgradedLaptop = (saved: Partial<ServerSettings>) =>
      vi.fn(async ({ environmentId }: { environmentId: EnvironmentId }) => ({
        _tag: "Success" as const,
        value: {
          ...DEFAULT_SERVER_SETTINGS,
          ...(environmentId === laptop.environmentId ? saved : {}),
        },
      }));
    const outcome = async (
      plan: ReturnType<typeof planScopedSettingsPatch>,
      persistServer: ReturnType<typeof upgradedLaptop>,
    ) => {
      const result = await persistScopedSettingsPatch(plan, persistServer, vi.fn());
      return {
        saved: result.savedEnvironments.map(({ label }) => label),
        failed: result.failedEnvironments.map(({ label, message }) => ({ label, message })),
      };
    };
    const unsupported = [
      {
        label: server.label,
        message: "This environment does not support this setting. Update T3 Code on it.",
      },
    ];

    it("reports a dropped toggle", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuidesEnabled: true }),
          upgradedLaptop({ reviewGuidesEnabled: true }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("reports dropped text but accepts the server trimming it", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuideInstructions: " Read tests " }),
          upgradedLaptop({ reviewGuideInstructions: "Read tests" }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    // regression: #18334 an environment silently dropped a setting with no warning
    it("reports a dropped key inside a project override", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(project, environments, { defaultAutoPull: true }),
          upgradedLaptop({
            projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } },
          }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("accepts a write that matches what the environment already had", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuidesEnabled: false }),
          upgradedLaptop({}),
        ),
      ).toEqual({ saved: [laptop.label, server.label], failed: [] });
    });
  });

  it("persists client keys locally at any scope alongside server keys", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, {
        diffIgnoreWhitespace: false,
        enableProviderUpdateChecks: false,
      }),
      persistServer,
      persistClient,
    );
    expect(persistClient).toHaveBeenCalledExactlyOnceWith({ diffIgnoreWhitespace: false });
    expect(persistServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: server.environmentId,
      input: { patch: { enableProviderUpdateChecks: false } },
    });
  });

  it("writes project overrides into each member's entry on its environment", () => {
    const withExisting = environment("Server", {
      settings: {
        projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
      },
    });
    const plan = planScopedSettingsPatch(project, [laptop, withExisting], {
      defaultAutoPull: true,
    });
    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: {
            [projectId]: { enableAgentBrowserAccess: false, defaultAutoPull: true },
          },
        },
      },
      {
        environmentId: laptop.environmentId,
        label: laptop.label,
        previous: expect.anything(),
        patch: { projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } } },
      },
    ]);
    expect(
      planScopedSettingsPatch(checkout, [laptop, server], { defaultAutoPull: true }),
    ).toMatchObject({
      serverWrites: [{ environmentId: server.environmentId }],
    });
  });

  it("keeps each project's other cleanup rules when changing one rule across machines", () => {
    const machine = environment("Laptop", {
      settings: {
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 30 },
      },
    });
    const customized = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            defaultAutoPull: true,
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: 8,
                worktreeSettledAfterDays: null,
                worktreeOnDelete: false,
                worktreeOnMerge: true,
                worktreeUnchanged: false,
                worktreeKeepWhen: "uncommitted-changes",
              },
            },
          },
        },
      },
    });
    const plan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } },
    });
    const settledPlan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeSettledAfterDays: 0 } },
    });
    expect(
      settledPlan.serverWrites.map((write) => write.patch.projectSettingsOverrides),
    ).toMatchObject([
      { [projectId]: { worktreeCleanup: { rules: { worktreeSettledAfterDays: 0 } } } },
      { [laptopProjectId]: { worktreeCleanup: { rules: { worktreeSettledAfterDays: 0 } } } },
    ]);
    expect(plan.serverWrites.map((write) => write.patch.projectSettingsOverrides)).toEqual([
      {
        [projectId]: {
          defaultAutoPull: true,
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 8,
              worktreeSettledAfterDays: null,
              worktreeOnDelete: true,
              worktreeOnMerge: true,
              worktreeUnchanged: false,
              worktreeKeepWhen: "uncommitted-changes",
            },
          },
        },
      },
      {
        [laptopProjectId]: {
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 30,
              worktreeSettledAfterDays: null,
              worktreeOnDelete: true,
              worktreeOnMerge: false,
              worktreeUnchanged: false,
              worktreeKeepWhen: "uncommitted-changes",
            },
          },
        },
      },
    ]);
    expect(
      planScopedSettingsClear(checkout, [customized], ["worktreeCleanup"]).serverWrites[0]?.patch,
    ).toEqual({
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    expect(
      planScopedSettingsPatch(project, [machine, customized], {
        storageCleanup: { browserArtifactsAfterDays: 8 },
      }).serverWrites,
    ).toEqual([]);
  });

  // regression: #11541 device settings were written to the wrong scope
  it("scopes agent device access to projects while keeping hub and hosts environment-wide", () => {
    const plan = planScopedSettingsPatch(project, [laptop, server], {
      enableAgentDeviceAccess: true,
    });
    expect(plan.serverWrites.map((write) => write.patch)).toEqual([
      { projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } } },
      { projectSettingsOverrides: { [laptopProjectId]: { enableAgentDeviceAccess: true } } },
    ]);
    for (const patch of [{ enableDeviceSupport: true }, { deviceHosts: [] }]) {
      expect(planScopedSettingsPatch(project, environments, patch).serverWrites).toEqual([]);
    }
  });

  it("refuses environment-wide keys at project scope", () => {
    expect(
      planScopedSettingsPatch(project, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "This setting is environment-wide and cannot be overridden by a project.",
    });
  });

  // regression: #35093 client settings saved in project scope overwrote the global default
  it("refuses client-only keys at project scope", () => {
    for (const scope of [project, checkout]) {
      expect(
        planScopedSettingsPatch(scope, environments, {
          browserDefaultViewport: { _tag: "freeform", width: 1440, height: 900 },
        }),
      ).toMatchObject({
        clientPatch: {},
        hasClientWrite: false,
        serverWrites: [],
        unavailableReason:
          "This setting is environment-wide and cannot be overridden by a project.",
      });
      expect(
        planScopedSettingsPatch(
          scope,
          environments,
          { fontSizeInterface: 15 },
          { deviceOnly: true },
        ),
      ).toMatchObject({ clientPatch: { fontSizeInterface: 15 }, unavailableReason: null });
    }
  });

  it("clears overrides per member and removes an emptied entry", () => {
    const withOverrides = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        },
      },
    });
    const plan = planScopedSettingsClear(checkout, [laptop, withOverrides], ["defaultAutoPull"]);
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: { projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } } },
      },
    ]);
    expect(
      planScopedSettingsClear(
        checkout,
        [laptop, withOverrides],
        ["defaultAutoPull", "enableAgentBrowserAccess"],
      ).serverWrites[0]?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: null } });
  });

  it("never substitutes an environment-default write for an invalid scope", () => {
    const scope = resolveSettingsScope({ machine: "removed" }, [group], environments);
    const plan = planScopedSettingsPatch(scope, environments, { enableAgentBrowserAccess: false });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.hasClientWrite).toBe(false);
    expect(plan.unavailableReason).not.toBeNull();
  });

  it("waits for every target and identifies both RPC failures and rejected writes", async () => {
    const third = environment("Third");
    const fourth = environment("Fourth");
    const selected = [...environments, third, fourth];
    const scope = resolveSettingsScope({}, [], selected);
    const persistServer = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: "settings:write",
            message: "This connection lacks permission to change settings.",
          }),
        ),
      })
      .mockRejectedValueOnce(new Error("Disconnected during save"))
      .mockResolvedValueOnce({ _tag: "Success" });
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(scope, selected, { enableAgentBrowserAccess: false }),
      persistServer,
      vi.fn(),
    );
    expect(result.savedEnvironmentCount).toBe(2);
    expect(result.savedEnvironments.map(({ label }) => label)).toEqual([
      laptop.label,
      fourth.label,
    ]);
    expect(result.failedEnvironments.map(({ message }) => message)).toEqual([
      "This connection lacks permission to change settings.",
      "Disconnected during save",
    ]);
    expect(result.failedEnvironments.map(({ label }) => label)).toEqual([
      server.label,
      third.label,
    ]);
    expect(persistServer).toHaveBeenCalledTimes(4);
  });

  describe("rapid project saves on one environment", () => {
    const saving = (initial: ServerSettings) => {
      let stored = initial;
      const persistServer = vi.fn(async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
        stored = applyServerSettingsPatch(stored, input.patch);
        return { _tag: "Success" as const, value: stored };
      });
      return { persistServer, stored: () => stored };
    };

    // regression: #18426 rapid project saves rebuilt overrides from a copy that trailed them
    it("keeps every edit and reset while the client's copy trails its saves", async () => {
      let copy: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
      };
      const host = saving(copy);
      // No config push arrives, so the client's copy stays as it was before the first save.
      const write = createScopedSettingsWriter(() => copy);
      const save = (plan: Parameters<typeof write>[1]) =>
        write([environment("Server", { settings: copy })], plan, host.persistServer, vi.fn());
      await Promise.all([
        save((current) => planScopedSettingsPatch(checkout, current, { defaultAutoPull: true })),
        save((current) => planScopedSettingsClear(checkout, current, ["enableAgentBrowserAccess"])),
        save((current) =>
          planScopedSettingsPatch(checkout, current, { removeAgentCreditsOnMerge: true }),
        ),
      ]);
      expect(host.stored().projectSettingsOverrides[projectId]).toEqual({
        defaultAutoPull: true,
        removeAgentCreditsOnMerge: true,
      });
      // The first save's push arrives late, after the newer saves have finished.
      copy = (await host.persistServer.mock.results[0]!.value).value;
      await save((current) =>
        planScopedSettingsPatch(checkout, current, { defaultThreadEnvMode: "worktree" }),
      );
      expect(host.stored().projectSettingsOverrides[projectId]).toEqual({
        defaultAutoPull: true,
        removeAgentCreditsOnMerge: true,
        defaultThreadEnvMode: "worktree",
      });
    });

    it.each(["remote", "previous save"] as const)(
      "keeps the current base when a %s push arrives during a save",
      async (push) => {
        let copy: ServerSettings = DEFAULT_SERVER_SETTINGS;
        const host = saving(copy);
        const write = createScopedSettingsWriter(() => copy);
        const edit = (patch: ServerSettingsPatch) =>
          write(
            [environment("Server", { settings: copy })],
            (current) => planScopedSettingsPatch(checkout, current, patch),
            host.persistServer,
            vi.fn(),
          );
        await edit({ defaultAutoPull: true });
        const previous = host.stored();
        const persist = host.persistServer.getMockImplementation()!;
        host.persistServer.mockImplementationOnce(async (request) => {
          const response = await persist(request);
          if (push === "remote") {
            await persist({
              input: {
                patch: {
                  projectSettingsOverrides: {
                    [projectId]: { enableAgentBrowserAccess: false },
                  },
                },
              },
            });
            copy = host.stored();
          } else {
            copy = { ...previous };
          }
          return response;
        });
        await edit({ removeAgentCreditsOnMerge: true });
        await edit({ defaultThreadEnvMode: "worktree" });
        expect(host.stored().projectSettingsOverrides[projectId]).toEqual(
          push === "remote"
            ? { enableAgentBrowserAccess: false, defaultThreadEnvMode: "worktree" }
            : {
                defaultAutoPull: true,
                removeAgentCreditsOnMerge: true,
                defaultThreadEnvMode: "worktree",
              },
        );
      },
    );

    it("plans from a copy that changed after the last save, and saves again after a failure", async () => {
      let copy: ServerSettings = DEFAULT_SERVER_SETTINGS;
      const host = saving(copy);
      const write = createScopedSettingsWriter(() => copy);
      const edit = (patch: ServerSettingsPatch) =>
        write(
          [environment("Server", { settings: copy })],
          (current) => planScopedSettingsPatch(checkout, current, patch),
          host.persistServer,
          vi.fn(),
        );
      host.persistServer.mockRejectedValueOnce(new Error("Disconnected"));
      expect((await edit({ defaultAutoPull: true })).failedEnvironments).toMatchObject([
        { message: "Disconnected" },
      ]);
      expect((await edit({ defaultAutoPull: true })).savedEnvironmentCount).toBe(1);
      // Another client replaces the override, and its push reaches this client.
      await host.persistServer({
        input: {
          patch: { projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } } },
        },
      });
      copy = host.stored();
      await edit({ removeAgentCreditsOnMerge: true });
      expect(host.stored().projectSettingsOverrides[projectId]).toEqual({
        enableAgentBrowserAccess: false,
        removeAgentCreditsOnMerge: true,
      });
    });
  });
});

describe("scoped settings mixed values", () => {
  it("treats independently decoded equal nested settings as the same value", () => {
    const style = {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      mode: "custom" as const,
      customInstructions: "Use plain language",
    };
    const first = environment("First", { settings: { sourceControlWritingStyle: { ...style } } });
    const second = environment("Second", { settings: { sourceControlWritingStyle: { ...style } } });
    const targets = resolveScopedSettingsTargets(all, [first, second]);
    expect(scopedSettingsAreMixed(targets, ["sourceControlWritingStyle"])).toBe(false);
  });

  it("agrees while a save is in flight and follows the environment once it reports back", () => {
    const patch = { defaultRuntimeMode: "auto" as const };
    const saved = environment("Laptop", { settings: patch });
    let waiting = environment("Server");
    const save = {};
    let writes: readonly PendingScopedWrite[] = [saved, waiting].map(({ environmentId }) => ({
      save,
      environmentId,
      patch,
    }));
    const mixed = () =>
      scopedSettingsAreMixed(
        resolveScopedSettingsTargets(all, applyPendingScopedWrites([saved, waiting], writes)),
        ["defaultRuntimeMode"],
      );
    const settle = (environmentId: EnvironmentId, result?: ServerSettings) => {
      writes = settlePendingScopedWrites(
        writes,
        { save, environmentId },
        (id) => [saved, waiting].find((env) => env.environmentId === id)?.serverConfig?.settings,
        result,
      );
    };
    expect(mixed()).toBe(false);

    // Laptop already pushed its result; Server answers before its push arrives.
    settle(saved.environmentId, saved.serverConfig!.settings);
    settle(waiting.environmentId, applyServerSettingsPatch(waiting.serverConfig!.settings, patch));
    expect(writes.map(({ environmentId }) => environmentId)).toEqual([waiting.environmentId]);
    expect(mixed()).toBe(false);

    waiting = environment("Server", { settings: { defaultRuntimeMode: "approval-required" } });
    expect(mixed()).toBe(true);

    writes = [{ save, environmentId: waiting.environmentId, patch }];
    settle(waiting.environmentId);
    expect(writes).toEqual([]);
  });
});

describe("offline environments in a scope", () => {
  const label = (name: string) => ({ label: name });

  it("treats environments without a loaded config as offline", () => {
    expect(offlineScopedEnvironments(environments).map(({ label }) => label)).toEqual([
      "Offline",
      "Loading",
    ]);
  });

  it("names offline environments before anything is saved", () => {
    expect(describeOfflineScope([])).toBeNull();
    expect(describeOfflineScope(["Torrent"])).toBe(
      "Torrent is offline. Changes here won't reach it.",
    );
    expect(describeOfflineScope(["Torrent", "RW"])).toBe(
      "Torrent and RW are offline. Changes here won't reach them.",
    );
    expect(describeOfflineScope(["Torrent", "RW", "LinkMini"])).toBe(
      "Torrent, RW, and LinkMini are offline. Changes here won't reach them.",
    );
  });

  it("reports a save that skipped offline environments", () => {
    const saved = [label("LinkPro"), label("LinkMini"), label("RW")];
    expect(describeScopedSave({ saved, failed: [], skipped: [] })).toBeNull();
    expect(describeScopedSave({ saved, failed: [], skipped: [label("Torrent")] })).toEqual({
      type: "warning",
      title: "Not saved on Torrent",
      description: "Torrent is offline and was not changed.\nSaved on LinkPro, LinkMini, RW.",
    });
    expect(
      describeScopedSave({
        saved: [label("LinkPro")],
        failed: [],
        skipped: [label("Torrent"), label("RW")],
      }),
    ).toEqual({
      type: "warning",
      title: "Not saved on 2 environments",
      description: "Torrent and RW are offline and were not changed.\nSaved on LinkPro.",
    });
  });

  it("lists skipped environments with failures", () => {
    const failed = [{ label: "LinkMini", message: "Permission denied" }];
    expect(
      describeScopedSave({ saved: [label("LinkPro")], failed, skipped: [label("Torrent")] }),
    ).toEqual({
      type: "error",
      title: "Setting saved on some environments",
      description: [
        "Could not save on LinkMini: Permission denied",
        "Torrent is offline and was not changed.",
        "Saved on LinkPro.",
      ].join("\n"),
    });
    expect(describeScopedSave({ saved: [], failed, skipped: [] })).toEqual({
      type: "error",
      title: "Setting not saved",
      description: "Could not save on LinkMini: Permission denied",
    });
  });
});

describe("project overrides at environment scope", () => {
  const laptop = EnvironmentId.make("laptop");
  const fleet = ProjectId.make("fleet");
  const t3 = ProjectId.make("t3");
  const environment = (
    environmentId: EnvironmentId,
    overrides: ServerSettings["projectSettingsOverrides"],
  ) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" as const },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: overrides },
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  });

  it("clears only those keys and drops entries that become empty", () => {
    const plan = planProjectOverridesClear(
      [
        environment(laptop, {
          [fleet]: { defaultAutoPull: true, defaultThreadEnvMode: "local" },
          [t3]: { defaultAutoPull: true },
        }),
      ],
      [
        { environmentId: laptop, projectId: fleet },
        { environmentId: laptop, projectId: t3 },
      ],
      ["defaultAutoPull"],
    );
    expect(plan.serverWrites).toEqual([
      {
        environmentId: laptop,
        label: laptop,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: { [fleet]: { defaultThreadEnvMode: "local" }, [t3]: null },
        },
      },
    ]);
  });
});

describe("null patches at project scope", () => {
  it("removes the override for keys that cannot store null and keeps it for keys that can", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const scope = {
      kind: "project" as const,
      group: {} as never,
      environmentId: null,
      label: "fleet",
      members: [{ id: projectId, environmentId } as never],
      environmentIds: [environmentId],
    };
    const environments = [
      {
        environmentId,
        label: "Laptop",
        connection: { phase: "connected" as const },
        serverConfig: {
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              [projectId]: { defaultThreadEnvMode: "worktree" as const, defaultAutoPull: true },
            },
          },
          environment: { capabilities: { projectSettingsOverrides: true } },
        },
      },
    ];
    expect(
      planScopedSettingsPatch(scope, environments, { defaultThreadEnvMode: null }).serverWrites[0]
        ?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } } });
    expect(
      planScopedSettingsPatch(scope, environments, { defaultModelSelection: null }).serverWrites[0]
        ?.patch,
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          defaultThreadEnvMode: "worktree",
          defaultAutoPull: true,
          defaultModelSelection: null,
        },
      },
    });
  });
});

describe("partial object patches at project scope", () => {
  it("completes a writing style field patch from the target's effective value", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const member = {
      id: projectId,
      environmentId,
      physicalProjectKey: "laptop:/repo",
      environmentLabel: "Laptop",
      title: "fleet",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Keep it short.",
            followChangeRequestTemplates: false,
          },
        },
      },
    };
    const plan = planScopedSettingsPatch(
      {
        kind: "project",
        group: {} as never,
        environmentId: null,
        label: "fleet",
        members: [member as never],
        environmentIds: [environmentId],
      },
      [
        {
          environmentId,
          label: "Laptop",
          connection: { phase: "connected" },
          serverConfig: {
            settings,
          },
        },
      ],
      { sourceControlWritingStyle: { customInstructions: "Be terse." } },
    );
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          sourceControlWritingStyle: {
            mode: "custom",
            customInstructions: "Be terse.",
            followChangeRequestTemplates: false,
          },
        },
      },
    });
  });
});

describe("favorite intents", () => {
  const codex = ProviderInstanceId.make("codex");
  const sol = { provider: codex, model: "sol" };
  const luna = { provider: codex, model: "luna" };
  const intents = [
    { reorderModelFavorites: [luna, sol] },
    { setModelFavorites: [{ ...sol, favorite: true, options: [] }] },
  ] as const;

  it.each(intents)("sends %j to each connected environment in scope as it is", (intent) => {
    const plan = planScopedSettingsPatch(all, environments, intent);
    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites.map((write) => [write.environmentId, write.patch])).toEqual([
      [laptop.environmentId, intent],
      [server.environmentId, intent],
    ]);
    expect(planScopedSettingsPatch(named, environments, intent).serverWrites).toHaveLength(1);
  });

  it.each(intents)("keeps %j out of project overrides, which are written whole", (intent) => {
    expect(planScopedSettingsPatch(project, environments, intent)).toMatchObject({
      serverWrites: [],
      unavailableReason: "This setting is environment-wide and cannot be overridden by a project.",
    });
  });

  it.each(intents)("does not mistake %j for a key the server dropped", async (intent) => {
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(all, environments, intent),
      vi.fn(async () => ({ _tag: "Success" as const, value: DEFAULT_SERVER_SETTINGS })),
      vi.fn(),
    );
    expect(result.failedEnvironments).toEqual([]);
    expect(result.savedEnvironmentCount).toBe(2);
  });
});

it("routes legacy model preference keys exclusively to the selected environment", () => {
  const patch = {
    favorites: [{ provider: ProviderInstanceId.make("codex"), model: "sol" }],
    providerModelPreferences: {},
  };
  const plan = planScopedSettingsPatch(named, environments, patch);
  expect(plan.clientPatch).toEqual({});
  expect(plan.hasClientWrite).toBe(false);
  expect(plan.serverWrites).toEqual([
    {
      environmentId: server.environmentId,
      label: server.label,
      previous: expect.anything(),
      patch,
    },
  ]);
});

describe("model selection patches at project scope", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const saved = {
    instanceId: codex,
    model: "gpt-5.6",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const customized = environment("Server", {
    settings: {
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: { ...saved, followLatest: true },
          sourceControlWriterModelSelection: saved,
          reviewGuideModelSelection: saved,
          textGenerationModelSelection: saved,
        },
      },
    },
  });

  it("applies family following with independent versions and options at every scope", () => {
    const first = { ...saved, model: "gpt-6.1-sol", followLatest: true };
    const second = { ...saved, model: "gpt-6.2-sol", options: [], followLatest: true };
    const defaults = [
      { environmentId: laptop.environmentId, projectId: laptopProjectId, selection: first },
      { environmentId: server.environmentId, projectId, selection: second },
    ];
    const projectPlan = planScopedModelDefaults(project, [laptop, customized], defaults);
    expect(projectPlan.serverWrites.map((write) => write.patch)).toEqual([
      {
        projectSettingsOverrides: {
          [projectId]: {
            ...customized.serverConfig?.settings.projectSettingsOverrides[projectId],
            defaultModelSelection: second,
          },
        },
      },
      { projectSettingsOverrides: { [laptopProjectId]: { defaultModelSelection: first } } },
    ]);
    const envPlan = planScopedModelDefaults(
      all,
      environments,
      defaults.map((target) => ({ ...target, projectId: null })),
    );
    expect(envPlan.serverWrites.map((write) => write.patch)).toEqual([
      { defaultModelSelection: first },
      { defaultModelSelection: second },
    ]);
    const pinned = applyServerSettingsPatch(
      { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: first },
      { defaultModelSelection: saved },
    );
    expect(pinned.defaultModelSelection).toEqual(saved);
  });

  // regression: #16581 changing a project's model kept the old model's options
  it("replaces old options when changing model selections", () => {
    const plan = planScopedSettingsPatch(checkout, [customized], {
      defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" },
      sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      reviewGuideModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      textGenerationModelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
    expect(plan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]).toEqual({
      defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" },
      sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      reviewGuideModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      textGenerationModelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
  });

  it("completes partial text-generation selections without retaining old options", () => {
    const modelPlan = planScopedSettingsPatch(checkout, [customized], {
      textGenerationModelSelection: { model: "gpt-5.6-mini" },
    });
    expect(
      modelPlan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]
        ?.textGenerationModelSelection,
    ).toEqual({ instanceId: codex, model: "gpt-5.6-mini" });

    const options = [{ id: "reasoningEffort", value: "low" }];
    const optionsPlan = planScopedSettingsPatch(checkout, [customized], {
      textGenerationModelSelection: { options },
    });
    expect(
      optionsPlan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]
        ?.textGenerationModelSelection,
    ).toEqual({ ...saved, options });
  });
});
