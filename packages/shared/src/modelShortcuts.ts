import {
  MAX_EFFORT_SLIDER_STEPS,
  type ModelFavorite,
  type ModelPreferences,
  type ModelSelection,
  type ProjectId,
  type ProviderOptionSelection,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "./projectSettings.ts";
import { resolveModelPreferences } from "./serverSettings.ts";

export type ModelShortcutKey = "favorites" | "effortSlider";
/** Where a list comes from: the environment's own, or a project that overrides it. */
export type ModelShortcutSource = "environment" | "project";

export interface ModelShortcuts {
  readonly favorites: ReadonlyArray<ModelFavorite>;
  readonly favoritesSource: ModelShortcutSource;
  readonly effortSlider: ReadonlyArray<ModelSelection>;
  readonly effortSliderSource: ModelShortcutSource;
}

/**
 * The favorites (in the user's order) and effort slider steps a project sees: its own override of
 * each list, else the environment's. An environment that never moved its favorites falls back to
 * this client's saved ones, like every other reader of them.
 */
export function resolveModelShortcuts(
  settings: ServerSettings,
  projectId: ProjectId | null,
  legacy: Partial<ModelPreferences> = {},
): ModelShortcuts {
  const { settings: effective, sources } = resolveProjectSettings(settings, projectId);
  return {
    favorites: resolveModelPreferences(effective, legacy).favorites,
    favoritesSource: sources.favorites === "project" ? "project" : "environment",
    effortSlider:
      effective.effortSlider.length > MAX_EFFORT_SLIDER_STEPS
        ? effective.effortSlider.slice(0, MAX_EFFORT_SLIDER_STEPS)
        : effective.effortSlider,
    effortSliderSource: sources.effortSlider === "project" ? "project" : "environment",
  };
}

type ModelShortcutValues = {
  readonly favorites: ReadonlyArray<ModelFavorite>;
  readonly effortSlider: ReadonlyArray<ModelSelection>;
};

/**
 * Stores one list where an edit of it belongs: the project's own override when it has one,
 * otherwise the environment. A project override is written whole because the server replaces
 * a project's entry; the environment keys are replaced as lists.
 */
export function planModelShortcutWrite<K extends ModelShortcutKey>(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId | null,
  key: K,
  value: ModelShortcutValues[K],
): ServerSettingsPatch {
  const entry = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  if (projectId !== null && entry !== undefined && entry[key] !== undefined) {
    return { projectSettingsOverrides: { [projectId]: { ...entry, [key]: value } } };
  }
  return { [key]: value };
}

/** `top` wins per option id; ids only `base` holds stay. Empty is no options at all. */
export function overlayProviderOptions(
  base: ReadonlyArray<ProviderOptionSelection> | undefined,
  top: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const merged = new Map((base ?? []).map((option) => [option.id, option] as const));
  for (const option of top ?? []) merged.set(option.id, option);
  return merged.size === 0 ? undefined : [...merged.values()];
}

/**
 * The options a favorite opens with: what was last used for the model, then the favorite's own
 * (its effort) on top. A favorite without options is the model's last used options, as before.
 */
export function resolveFavoritePickOptions(
  lastUsed: ReadonlyArray<ProviderOptionSelection> | undefined,
  favorite: Pick<ModelFavorite, "options"> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const options = overlayProviderOptions(lastUsed, favorite?.options);
  return options?.length ? options : undefined;
}
