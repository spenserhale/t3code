import {
  DEFAULT_SERVER_SETTINGS,
  MAX_EFFORT_SLIDER_STEPS,
  ProjectId,
  ProviderInstanceId,
  type ModelFavorite,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  overlayProviderOptions,
  planModelShortcutWrite,
  resolveFavoritePickOptions,
  resolveModelShortcuts,
} from "./modelShortcuts.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const provider = ProviderInstanceId.make("codex");
const effort = (value: string) => [{ id: "reasoningEffort", value }];
const step = (model: string, value: string): ModelSelection =>
  createModelSelection(provider, model, effort(value));

const environmentFavorites: ModelFavorite[] = [
  { provider, model: "sol" },
  { provider, model: "luna", options: effort("low") },
];
const environmentSteps = [step("luna", "low"), step("sol", "high")];
const projectFavorites: ModelFavorite[] = [{ provider, model: "astra", options: effort("max") }];

const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  favorites: environmentFavorites,
  effortSlider: environmentSteps,
  projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
};

describe("resolveModelShortcuts", () => {
  it("follows the environment until a project overrides a list, each list on its own", () => {
    expect(resolveModelShortcuts(settings, null)).toEqual({
      favorites: environmentFavorites,
      favoritesSource: "environment",
      effortSlider: environmentSteps,
      effortSliderSource: "environment",
    });
    expect(resolveModelShortcuts(settings, projectId)).toMatchObject({
      favoritesSource: "environment",
      effortSliderSource: "environment",
    });

    const overriding = applyServerSettingsPatch(settings, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, favorites: projectFavorites },
      },
    });
    expect(resolveModelShortcuts(overriding, projectId)).toEqual({
      favorites: projectFavorites,
      favoritesSource: "project",
      effortSlider: environmentSteps,
      effortSliderSource: "environment",
    });
    expect(resolveModelShortcuts(overriding, null).favorites).toEqual(environmentFavorites);
    expect(resolveModelShortcuts(overriding, ProjectId.make("project-b")).favorites).toEqual(
      environmentFavorites,
    );
  });

  it("lets a project clear a list the environment filled", () => {
    const cleared = applyServerSettingsPatch(settings, {
      projectSettingsOverrides: { [projectId]: { effortSlider: [], favorites: [] } },
    });
    expect(resolveModelShortcuts(cleared, projectId)).toMatchObject({
      favorites: [],
      favoritesSource: "project",
      effortSlider: [],
      effortSliderSource: "project",
    });
  });

  it("falls back to the favorites this client saved before the server held any", () => {
    const legacy = { favorites: [{ provider, model: "old" }] };
    expect(
      resolveModelShortcuts({ ...DEFAULT_SERVER_SETTINGS, favorites: null }, null, legacy)
        .favorites,
    ).toEqual(legacy.favorites);
    expect(
      resolveModelShortcuts({ ...DEFAULT_SERVER_SETTINGS, favorites: [] }, null, legacy).favorites,
    ).toEqual([]);
  });

  it("shows no more steps than the slider has room for", () => {
    const tooMany = Array.from({ length: MAX_EFFORT_SLIDER_STEPS + 2 }, (_, index) =>
      step(`model-${index}`, "high"),
    );
    expect(
      resolveModelShortcuts({ ...DEFAULT_SERVER_SETTINGS, effortSlider: tooMany }, null)
        .effortSlider,
    ).toEqual(tooMany.slice(0, MAX_EFFORT_SLIDER_STEPS));
  });
});

describe("planModelShortcutWrite", () => {
  it("writes the environment's list unless the project already overrides it", () => {
    const next = [{ provider, model: "sol" }];
    expect(planModelShortcutWrite(settings, null, "favorites", next)).toEqual({ favorites: next });
    expect(planModelShortcutWrite(settings, projectId, "favorites", next)).toEqual({
      favorites: next,
    });
  });

  it("rewrites the project's whole entry when it overrides the list, keeping its other overrides", () => {
    const overriding = applyServerSettingsPatch(settings, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, effortSlider: [step("sol", "low")] },
      },
    });
    const next = [step("sol", "low"), step("sol", "high")];
    const patch = planModelShortcutWrite(overriding, projectId, "effortSlider", next);
    expect(patch).toEqual({
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, effortSlider: next },
      },
    });
    // The other list is still the environment's.
    expect(
      planModelShortcutWrite(overriding, projectId, "favorites", [{ provider, model: "sol" }]),
    ).toEqual({ favorites: [{ provider, model: "sol" }] });
    const applied = applyServerSettingsPatch(overriding, patch);
    expect(resolveModelShortcuts(applied, projectId).effortSlider).toEqual(next);
    expect(applied.projectSettingsOverrides[projectId]?.defaultAutoPull).toBe(true);
    expect(applied.effortSlider).toEqual(environmentSteps);
  });
});

describe("favorite picks", () => {
  it("puts the favorite's effort over what was last used for the model", () => {
    const lastUsed = [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "low" },
    ];
    expect(resolveFavoritePickOptions(lastUsed, { options: effort("high") })).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);
    expect(resolveFavoritePickOptions(undefined, { options: effort("high") })).toEqual(
      effort("high"),
    );
  });

  it("is exactly the last used options for a favorite without an effort", () => {
    const lastUsed = effort("low");
    expect(resolveFavoritePickOptions(lastUsed, {})).toEqual(lastUsed);
    expect(resolveFavoritePickOptions(lastUsed, undefined)).toEqual(lastUsed);
    expect(resolveFavoritePickOptions(undefined, undefined)).toBeUndefined();
    expect(overlayProviderOptions([], [])).toBeUndefined();
  });
});
