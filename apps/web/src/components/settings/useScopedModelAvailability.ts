import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProviders,
  textGeneratorForSelection,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

function modelCatalogForTarget(
  target: ScopedSettingsTarget,
  providers: ServerProviders,
  settings: UnifiedSettings,
) {
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    target.settings,
    target.projectId,
  );
  const targetSettings = mergeEnvironmentSettings(target.settings, settings);
  return new Map(
    entries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => [
        entry.instanceId,
        {
          driver: entry.driverKind,
          models: new Set(
            getAppModelOptionsForInstance(targetSettings, entry)
              .filter((option) => !option.isUnavailable)
              .map((option) => option.slug),
          ),
        },
      ]),
  );
}

export function useScopedModelUnavailableEnvironments(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
) {
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const labels = new Map(
    environments.map((environment) => [
      environment.environmentId,
      settingsScopeEnvironmentLabel(environment, environments),
    ]),
  );
  const catalogs = new Map(
    targets.flatMap((target) => {
      const providers = providersByEnvironment.get(target.environmentId);
      return providers ? [[target, modelCatalogForTarget(target, providers, settings)]] : [];
    }),
  );
  return (instanceId: ProviderInstanceId, model: string): ReadonlyMap<EnvironmentId, string> => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    const shownGenerator = textGeneratorForSelection(settings, instanceId);
    const unavailable = new Map<EnvironmentId, string>();
    for (const candidate of targets) {
      if (unavailable.has(candidate.environmentId)) continue;
      const label = labels.get(candidate.environmentId) ?? candidate.label;
      const generator = textGeneratorForSelection(candidate.settings, instanceId);
      if (shownGenerator !== undefined || generator !== undefined) {
        // Only the shown environment's model list is loaded; elsewhere it must reach the same API.
        if (
          !generator?.enabled ||
          generator.kind !== shownGenerator?.kind ||
          generator.baseUrl !== shownGenerator.baseUrl
        ) {
          unavailable.set(candidate.environmentId, label);
        }
        continue;
      }
      const catalog = catalogs.get(candidate);
      if (!catalog) continue;
      const entry = catalog.get(instanceId);
      if (!entry || entry.driver !== sourceEntry?.driverKind || !entry.models.has(model)) {
        unavailable.set(candidate.environmentId, label);
      }
    }
    return unavailable;
  };
}

export function scopedModelDisabledReason(unavailable: ReadonlyMap<EnvironmentId, string>) {
  return unavailable.size > 0
    ? `This model is unavailable on ${[...unavailable.values()].join(", ")}.`
    : null;
}

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
) {
  const unavailableEnvironments = useScopedModelUnavailableEnvironments(settings, entries);
  return (instanceId: ProviderInstanceId, model: string) =>
    scopedModelDisabledReason(unavailableEnvironments(instanceId, model));
}
