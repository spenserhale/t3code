import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  MAX_EFFORT_SLIDER_STEPS,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  planModelShortcutWrite,
  resolveModelShortcuts,
  resolveProviderEffortSlider,
} from "@t3tools/shared/modelShortcuts";
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
const noCapabilitiesAtom = Atom.make<undefined>(undefined);
const modelShortcutsCapabilitiesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities,
  ).pipe(Atom.withLabel(`web-model-shortcuts-capabilities:${environmentId}`)),
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
  const capabilities = useAtomValue(
    environmentId ? modelShortcutsCapabilitiesAtom(environmentId) : noCapabilitiesAtom,
  );
  const legacyFavorites = useClientSettings((client) => client.favorites);
  return {
    settings,
    effortSliderSupported: capabilities?.effortSlider === true,
    providerEffortSlidersSupported: capabilities?.providerEffortSliders === true,
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

export function useAddEffortSliderStep(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  const registry = use(RegistryContext);
  const save = useUpdateEnvironmentModelPreferences(environmentId);
  return async (step: ModelSelection, driver: ProviderDriverKind | null) => {
    const settings = environmentId
      ? registry.get(serverEnvironment.settingsValueAtom(environmentId))
      : null;
    if (!settings) return;
    if (driver !== null) {
      const slider = resolveProviderEffortSlider(settings, projectId, driver);
      if (!slider || slider.steps.length >= MAX_EFFORT_SLIDER_STEPS) return;
      await save({
        setProviderEffortSliders: [
          {
            driver,
            ...(slider.source === "project" && projectId !== null ? { projectId } : {}),
            steps: [...slider.steps, step],
          },
        ],
      });
      return;
    }
    const { effortSlider } = resolveModelShortcuts(settings, projectId);
    if (effortSlider.length >= MAX_EFFORT_SLIDER_STEPS) return;
    await save(
      planModelShortcutWrite(settings, projectId, "effortSlider", [...effortSlider, step]),
    );
  };
}
