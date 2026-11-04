import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  MAX_EFFORT_SLIDER_STEPS,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { planModelShortcutWrite, resolveModelShortcuts } from "@t3tools/shared/modelShortcuts";
import { Atom } from "effect/reactivity";
import { use } from "react";

import { serverEnvironment } from "~/state/server";
import {
  getClientSettings,
  useClientSettings,
  useToggleEnvironmentModelFavorite,
  useUpdateEnvironmentModelPreferences,
} from "./useSettings";

const noSettingsAtom = Atom.make<ServerSettings | null>(null);
const noSupportAtom = Atom.make(false);
const effortSliderSupportAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
        .effortSlider === true,
  ).pipe(Atom.withLabel(`web-effort-slider-support:${environmentId}`)),
);

/**
 * The favorites (in the user's order) and effort slider steps a project sees on an environment.
 * `effortSliderSupported` is false where the server would drop the slider and favorite efforts.
 */
export function useEnvironmentModelShortcuts(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  const settings = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : noSettingsAtom,
  );
  const effortSliderSupported = useAtomValue(
    environmentId ? effortSliderSupportAtom(environmentId) : noSupportAtom,
  );
  const legacyFavorites = useClientSettings((client) => client.favorites);
  return {
    settings,
    effortSliderSupported,
    ...resolveModelShortcuts(settings ?? DEFAULT_SERVER_SETTINGS, projectId, {
      favorites: legacyFavorites,
    }),
  };
}

/**
 * Stars or unstars a model where the picker's favorites come from: the project's own list when it
 * has one, otherwise the environment's, which merges with other clients' changes.
 */
export function useToggleModelFavorite(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  const registry = use(RegistryContext);
  const toggleEnvironmentFavorite = useToggleEnvironmentModelFavorite(environmentId);
  const save = useUpdateEnvironmentModelPreferences(environmentId);
  return async (provider: ProviderInstanceId, model: string) => {
    const settings = environmentId
      ? registry.get(serverEnvironment.settingsValueAtom(environmentId))
      : null;
    const shortcuts =
      settings && projectId
        ? resolveModelShortcuts(settings, projectId, { favorites: getClientSettings().favorites })
        : null;
    if (!settings || !projectId || shortcuts?.favoritesSource !== "project") {
      return toggleEnvironmentFavorite(provider, model);
    }
    const isFavorite = shortcuts.favorites.some(
      (favorite) => favorite.provider === provider && favorite.model === model,
    );
    await save(
      planModelShortcutWrite(
        settings,
        projectId,
        "favorites",
        isFavorite
          ? shortcuts.favorites.filter(
              (favorite) => favorite.provider !== provider || favorite.model !== model,
            )
          : [...shortcuts.favorites, { provider, model }],
      ),
    );
  };
}

/** Appends a step to the slider, in the project's own list when it has one. */
export function useAddEffortSliderStep(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  const registry = use(RegistryContext);
  const save = useUpdateEnvironmentModelPreferences(environmentId);
  return async (step: ModelSelection) => {
    const settings = environmentId
      ? registry.get(serverEnvironment.settingsValueAtom(environmentId))
      : null;
    if (!settings) return;
    const { effortSlider } = resolveModelShortcuts(settings, projectId);
    if (effortSlider.length >= MAX_EFFORT_SLIDER_STEPS) return;
    await save(
      planModelShortcutWrite(settings, projectId, "effortSlider", [...effortSlider, step]),
    );
  };
}
